"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CapacityAiDiagnosis, CapacityCalibrationPreview, CapacityExperiments, LearningCapacityReport } from "@/src/core";
import { recallAnswerHref } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
import { RecallAnalysis } from "@/components/recall-analysis";
import { RecallAudit } from "@/components/recall-audit";
import { RecallCapacityEvidence } from "@/components/recall-capacity-evidence";
import { cn } from "@/lib/utils";
import {
	ActivityIcon,
	BrainIcon,
	CheckCircle2Icon,
	MessageSquareTextIcon,
	RefreshCwIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";

const tabs = ["overview", "recall", "audit", "groups"] as const;
const CapacityRecallAnalysis = memo(RecallAnalysis);
const CapacityRecallAudit = memo(RecallAudit);
type CapacityTab = typeof tabs[number];
const tabLabels: Record<CapacityTab, string> = { overview: "Overview", recall: "Recall", audit: "Audit", groups: "Topic groups" };
type Activity = { audit: Array<{ done: number; total: number }>; groups: Array<{ subject: string; done: number; total: number }> };
type DiagnosisPreview = { revision: string; modelLabel: string; systemPrompt: string; payload: unknown; responseSchema: unknown; estimateUsd: number | null; inputTokens: number; outputTokens: number };

async function capacityAction<T>(body: Record<string, unknown>): Promise<T> {
	const response = await fetch("/api/planner/capacity", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
	return result as T;
}

function ExperimentResult({ label, result }: { label: string; result: CapacityExperiments["recall"] }) {
	if (result.status === "insufficient") return <p>{label}: not enough eligible history ({result.observations} events).</p>;
	return <div className="space-y-1">
		<p><strong>{label}</strong> · {result.train} train / {result.test} later tests · {result.status === "improved" ? "better on both measures" : "baseline retained"}</p>
		<p>Brier {result.measured.brier.toFixed(3)} vs {result.reference.brier.toFixed(3)} · log-loss {result.measured.logLoss.toFixed(3)} vs {result.reference.logLoss.toFixed(3)}.</p>
		{"next" in result && result.next && <p>Experimental: {Math.round(result.next.full * 100)}% chance of a full answer on the next independent question in the latest {result.next.subject} session.</p>}
	</div>;
}

interface CapacityResponse {
	report: LearningCapacityReport;
	aiAvailability: {
		coach: { available: boolean; modelLabel: string | null };
		availableRoles?: Array<{ role: string; label: string; modelLabel: string }>;
	};
}

function RecallInsightsDetail({ insights, range }: { insights: LearningCapacityReport["subjectBreakdown"][number]["recallInsights"]; range: "last30" | "allTime" }) {
	const data = insights[range];
	return <div className="mt-2 min-w-56 space-y-1 text-muted-foreground">
		<p>{data.days} days · {Math.max(0, data.responses - data.assessed)} not assessed{data.needsReview ? ` (${data.needsReview} changed answers need review)` : ""}</p>
		{data.staleExamples.length > 0 && <p>Changed answers: {data.staleExamples.map((item, index) => <a key={`${item.chatId}:${item.toolCallId ?? index}`} className="underline" href={recallAnswerHref(item.chatId, item.sourceMessageId, item.toolCallId)}>open answer {index + 1} </a>)}</p>}
		<p>{data.correct} correct · {data.partial} partial · {data.wrong} incorrect · {data.dontKnow} did not know · {data.uncertain} uncertain</p>
		<p>{data.ai} provisional AI assessments · {data.confirmed} learner corrections</p>
		<p>Help: {data.independent} independent · {data.assisted} assisted · {data.helpUnknown} unknown</p>
		{data.medianTimerMin !== null && <p>Recorded timer: median {data.medianTimerMin} min ({data.timerCount} answers; may include other activities).</p>}
		{data.medianElapsedMin !== null && <p>Elapsed question-to-answer: median {data.medianElapsedMin} min ({data.elapsedCount} answers; {data.elapsedOver3h} over 3h). This includes breaks and is not solving time.</p>}
		{range === "last30" && <p>{insights.trend ? `Compared with the previous 30 days: correct ${insights.trend.correctRateDelta >= 0 ? "+" : ""}${insights.trend.correctRateDelta} pp, partial ${insights.trend.partialRateDelta >= 0 ? "+" : ""}${insights.trend.partialRateDelta} pp. Question difficulty may differ.` : "Not enough assessed answers across both periods to compare trends."}</p>}
	</div>;
}

export function PlannerCapacityModal({
	open,
	onClose,
	date,
	selectedRole,
	onChangeRole,
	onSnapshotUpdated,
	onAskCoachWithReport,
}: {
	open: boolean;
	onClose: () => void;
	date: string;
	selectedRole: string;
	onChangeRole: (role: string) => void;
	onSnapshotUpdated: () => Promise<void>;
	onAskCoachWithReport: (prompt: string) => void;
}) {
	const [data, setData] = useState<CapacityResponse | null>(null);
	const [diagnosis, setDiagnosis] = useState<CapacityAiDiagnosis | null>(null);
	const [loading, setLoading] = useState(false);
	const [aiBusy, setAiBusy] = useState(false);
	const [calibrating, setCalibrating] = useState(false);
	const [statusMsg, setStatusMsg] = useState<string | null>(null);
	const [errMsg, setErrMsg] = useState<string | null>(null);
	const [recallRange, setRecallRange] = useState<"last30" | "allTime">("last30");
	const [tab, setTab] = useState<CapacityTab>("overview");
	const [visited, setVisited] = useState<ReadonlySet<CapacityTab>>(() => new Set(["overview"]));
	const [activity, setActivity] = useState<Activity>({ audit: [], groups: [] });
	const [evidenceId, setEvidenceId] = useState<string>();
	const clearEvidenceId = useCallback(() => setEvidenceId(undefined), []);
	const [calibration, setCalibration] = useState<CapacityCalibrationPreview | null>(null);
	const [selectedChanges, setSelectedChanges] = useState<string[]>([]);
	const [realism, setRealism] = useState(false);
	const [undoId, setUndoId] = useState<string | null>(null);
	const [diagnosisPreview, setDiagnosisPreview] = useState<DiagnosisPreview | null>(null);
	const [experiments, setExperiments] = useState<CapacityExperiments | null>(null);
	const [experimentBusy, setExperimentBusy] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const offsets = useRef<Partial<Record<CapacityTab, number>>>({});
	const showTab = (next: CapacityTab) => {
		offsets.current[tab] = scroller.current?.scrollTop ?? 0;
		setVisited((old) => old.has(next) ? old : new Set([...old, next]));
		setTab(next);
	};
	useEffect(() => { if (scroller.current) scroller.current.scrollTop = offsets.current[tab] ?? 0; }, [tab]);

	const fetchReport = useCallback(async () => {
		setLoading(true);
		setErrMsg(null);
		try {
			const res = await fetch(`/api/planner/capacity?date=${encodeURIComponent(date)}`, { cache: "no-store" });
			const body = (await res.json()) as CapacityResponse & { error?: string };
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			setData(body);
		} catch (e) {
			setErrMsg(e instanceof Error ? e.message : "Could not compute learning capacity metrics.");
		} finally {
			setLoading(false);
		}
	}, [date]);

	useEffect(() => {
		if (open) {
			setStatusMsg(null);
			void fetchReport();
			try {
				if (sessionStorage.getItem("lh:recall-return-state") || sessionStorage.getItem("lh:recall-return-subject")) {
					const saved = JSON.parse(sessionStorage.getItem("lh:recall-return-state") ?? "null") as { tab?: CapacityTab } | null;
					const next = saved?.tab === "recall" ? "recall" : "groups";
					setVisited((old) => new Set([...old, next]));
					setTab(next);
				} else setTab("overview");
			} catch { setTab("overview"); }
		}
	}, [open, fetchReport]);

	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		const refresh = async () => {
			try {
				const response = await fetch("/api/planner/capacity?activity=1", { cache: "no-store", signal: controller.signal });
				if (response.ok && !controller.signal.aborted) {
					const next = await response.json() as Activity;
					if (!controller.signal.aborted) setActivity((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
				}
			} catch { /* the next poll can recover */ }
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 6000);
		return () => { controller.abort(); clearInterval(timer); };
	}, [open]);

	const runAiDiagnosis = async (send: boolean) => {
		setAiBusy(true);
		setErrMsg(null);
		try {
			const options = { date, ...(selectedRole ? { preferredRole: selectedRole } : {}) };
			if (!send) {
				const preview = await capacityAction<DiagnosisPreview>({ action: "preview_diagnosis", ...options });
				setDiagnosisPreview(preview);
				return;
			}
			if (!diagnosisPreview) return;
			const result = await capacityAction<{ report: LearningCapacityReport; diagnosis: CapacityAiDiagnosis }>({
				action: "diagnose_ai", revision: diagnosisPreview.revision, ...options,
			});
			setData((current) => current ? { ...current, report: result.report } : current);
			setDiagnosis(result.diagnosis);
			setDiagnosisPreview(null);
			showTab("overview");
		} catch (error) {
			setDiagnosisPreview(null);
			setErrMsg(error instanceof Error ? error.message : "AI diagnosis failed.");
		} finally { setAiBusy(false); }
	};

	const calibrate = async (action: "preview_calibration" | "apply_calibration" | "undo_calibration") => {
		setCalibrating(true);
		setErrMsg(null);
		try {
			if (action === "preview_calibration") {
				const preview = await capacityAction<CapacityCalibrationPreview>({ action, date });
				setCalibration(preview);
				setSelectedChanges([]);
				setRealism(false);
				setUndoId(preview.undoId);
				return;
			}
			if (action === "apply_calibration" && calibration) {
				const result = await capacityAction<{ undoId: string; applied: number; realismApplied: boolean }>({
					action, date, revision: calibration.revision, items: selectedChanges, realism,
				});
				setUndoId(result.undoId);
				setStatusMsg(`Applied ${result.applied} study focus change(s)${result.realismApplied ? " and Realism for the next generated plan" : ""}.`);
			} else if (action === "undo_calibration" && (undoId ?? calibration?.undoId)) {
				await capacityAction({ action, undoId: undoId ?? calibration?.undoId });
				setUndoId(null);
				setStatusMsg("Calibration undone.");
			} else return;
			setCalibration(null);
			await onSnapshotUpdated();
			await fetchReport();
		} catch (error) {
			setCalibration(null);
			setErrMsg(error instanceof Error ? error.message : "Calibration failed.");
		} finally { setCalibrating(false); }
	};

	const runExperiments = async () => {
		setExperimentBusy(true);
		setErrMsg(null);
		try { setExperiments(await capacityAction<CapacityExperiments>({ action: "run_local_experiments", date })); }
		catch (error) { setErrMsg(error instanceof Error ? error.message : "Local experiment failed."); }
		finally { setExperimentBusy(false); }
	};

	if (!open) return null;

	const r = data?.report;

	return (
		<div
			data-testid="planner-capacity-modal"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-5"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl">
				{/* Modal Header */}
				<div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
					<div className="flex items-center gap-2.5">
						<div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<BrainIcon className="size-4" />
						</div>
						<div>
							<h2 className="text-sm font-semibold text-foreground">
								Learning Capacity Diagnostics
							</h2>
							<p className="text-[11px] text-muted-foreground">
								Recall evidence, FSRS-6, Practice, Quiz and planner history
							</p>
						</div>
					</div>
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							disabled={loading}
							onClick={() => void fetchReport()}
							title="Refresh metrics (0 tokens)"
							className="rounded-md border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
						>
							<RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
						</button>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close Learning Capacity"
							className="rounded-md border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<XIcon className="size-3.5" />
						</button>
					</div>
				</div>

				<nav aria-label="Learning Capacity views" className="flex flex-wrap items-center gap-1 border-b px-5 py-2 text-xs">
					{tabs.map((item) => <button key={item} type="button" aria-pressed={tab === item}
						onClick={() => showTab(item)} className="rounded-md px-2.5 py-1.5 aria-pressed:bg-accent aria-pressed:font-semibold">
						{tabLabels[item]}
					</button>)}
					{((activity.audit?.length ?? 0) > 0 || (activity.groups?.length ?? 0) > 0) && <span role="status" className="ml-auto text-muted-foreground">
						{[...(activity.audit ?? []).map((run) => `Audit ${run.done}/${run.total}`),
							...(activity.groups ?? []).map((run) => `${run.subject}: groups ${run.done}/${run.total}`)].join(" · ")}
					</span>}
				</nav>
				<div ref={scroller} className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
					{errMsg && (
						<div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
							{errMsg}
						</div>
					)}
					{statusMsg && (
						<div className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-success">
							<CheckCircle2Icon className="size-3.5 shrink-0" /> {statusMsg}
						</div>
					)}

					{loading && !r ? (
						<div className="flex items-center gap-2 py-10 text-muted-foreground">
							<BrailleSpinner /> Reading Knowledge Graph, FSRS-6 reviews, Quiz calibration, Mistakes &amp; Sessions...
						</div>
					) : r && tab === "overview" ? (
						<>
							{/* Composite Overview Strip */}
							<div className="grid gap-3 sm:grid-cols-4">
								<div className="rounded-xl border bg-background/70 p-3">
									<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
										Composite Index
									</div>
									<div className="mt-1 flex items-baseline gap-2">
										<span className="text-2xl font-bold text-foreground">
											{r.compositeScore !== null ? r.compositeScore : "—"}
										</span>
										<span className="text-[11px] text-muted-foreground">/ 100</span>
									</div>
									<div className="mt-1 flex flex-wrap items-center gap-1">
										<span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
											{r.tierLabel}
										</span>
										<span className="text-[10px] text-muted-foreground">({r.confidenceLevel})</span>
										{r.recallContribution && <small className="block w-full text-muted-foreground">Six dimensions: {r.legacyCompositeScore ?? "—"} · Recall {r.recallContribution.delta >= 0 ? "+" : ""}{r.recallContribution.delta.toFixed(2)} · {r.recallContribution.eligibleSubjects}/{r.recallContribution.activeSubjects} subjects</small>}
									</div>
								</div>

								<div className="rounded-xl border bg-background/70 p-3">
									<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
										Workload Pace Factor
									</div>
									<div className="mt-1 flex items-baseline gap-1.5">
										<span className="text-2xl font-bold text-foreground">{r.recommendedPaceFactor}×</span>
									</div>
									<p className="mt-1 text-[10px] text-muted-foreground">
										&gt;1.0× means topics need extra practice buffer; &lt;1.0× faster mastery.
									</p>
								</div>

								<div className="rounded-xl border bg-background/70 p-3">
									<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
										Metacognition (Brier)
									</div>
									<div className="mt-1 flex items-baseline gap-1.5">
										<span className="text-2xl font-bold text-foreground">
											{r.metacognition.brierScore !== null ? r.metacognition.brierScore : "—"}
										</span>
										{r.metacognition.calibrationBiasPct !== null && (
											<span
												className={cn(
													"text-[11px] font-medium",
													r.metacognition.biasDirection === "calibrated" ? "text-success" : "text-warning",
												)}
											>
												{r.metacognition.calibrationBiasPct > 0
													? `+${r.metacognition.calibrationBiasPct}%`
													: `${r.metacognition.calibrationBiasPct}%`}
											</span>
										)}
									</div>
									<p className="mt-1 text-[10px] text-muted-foreground">
										{r.metacognition.sampleCount > 0
											? `${r.metacognition.sampleCount} quiz confidence samples (${r.metacognition.biasDirection})`
											: "Needs quiz answers with confidence slider"}
									</p>
								</div>

								<div className="rounded-xl border bg-background/70 p-3">
									<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
										Sustainable Output
									</div>
									<div className="mt-1 flex items-baseline gap-1.5">
										<span className="text-2xl font-bold text-foreground">
											{r.recommendedDailyHours !== null ? `${r.recommendedDailyHours}h` : `${Math.round(r.recommendedRealismFactor * 100)}%`}
										</span>
									</div>
									<p className="mt-1 text-[10px] text-muted-foreground">
										Realism cap: {Math.round(r.recommendedRealismFactor * 100)}% across {r.dataCoverage.loggedPlannerDays} logged day(s)
									</p>
								</div>
							</div>

							{/* Data Coverage Telemetry Pills */}
							<div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
								<span className="font-medium text-foreground">Observed Workspace Telemetry:</span>
								<span className="rounded border bg-background px-1.5 py-0.5">
									{r.dataCoverage.fsrsReviews} FSRS reviews ({r.dataCoverage.trackedPropositions} cards{r.dataCoverage.hasCustomFsrsWeights ? ", 21 custom weights" : ""})
								</span>
								<span className="rounded border bg-background px-1.5 py-0.5">
									{r.dataCoverage.graphNodes} Graph concepts / {r.dataCoverage.graphChains} chains
								</span>
								<span className="rounded border bg-background px-1.5 py-0.5">
									{r.dataCoverage.quizConfidenceSamples} Quiz conf · {r.dataCoverage.practiceProblems} Practice concluded
									{(r.dataCoverage.recallExplainCount ?? 0) > 0 ? ` · ${r.dataCoverage.recallExplainCount} Explain/Recall` : ""}
								</span>
								<span className="rounded border bg-background px-1.5 py-0.5">
									{r.dataCoverage.mistakeRecords} Mistakes analyzed · {r.dataCoverage.pastChatSessions} Past sessions
								</span>
							</div>


							{/* 6 Scientific Criteria Cards */}
							<div>
								<h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-foreground">
									<ActivityIcon className="size-3.5 text-primary" /> 6 Scientific Dimensions of Learning Capacity
								</h3>
								<div className="grid gap-2.5 md:grid-cols-2">
									{r.dimensions.map((dim) => (
										<div key={dim.id} className="flex flex-col justify-between rounded-xl border bg-background/60 p-3">
											<div>
												<div className="flex items-start justify-between gap-2">
													<div>
														<div className="font-semibold text-foreground">{dim.title}</div>
														<div className="text-[10px] text-muted-foreground">{dim.scientificBasis}</div>
													</div>
													<div className="flex shrink-0 items-center gap-1">
														<span
															className={cn(
																"rounded-md border px-2 py-0.5 text-[11px] font-bold tabular-nums",
																dim.score === null
																	? "border-border text-muted-foreground"
																	: dim.score >= 75
																		? "border-success/40 bg-success/10 text-success"
																		: dim.score >= 55
																			? "border-primary/40 bg-primary/10 text-primary"
																			: "border-warning/40 bg-warning/10 text-warning",
															)}
														>
															{dim.score !== null ? `${dim.score}/100` : "—"}
														</span>
													</div>
												</div>

												<div className="mt-2 flex items-baseline gap-1.5">
													<span className="text-lg font-semibold text-foreground">{dim.primaryMetric.value}</span>
													<span className="text-[11px] text-muted-foreground">
														{dim.primaryMetric.unit} · {dim.primaryMetric.label}
													</span>
													<span className="ml-auto text-[10px] text-muted-foreground">n={dim.sampleCount}</span>
												</div>

												<div className="mt-2 flex flex-wrap gap-1.5">
													{dim.subMetrics.map((sm) => (
														<span key={sm.label} className="rounded border bg-card px-1.5 py-0.5 text-[10px]">
															<span className="text-muted-foreground">{sm.label}: </span>
															<span className="font-medium text-foreground">{sm.value}</span>
														</span>
													))}
												</div>
											</div>
											<p className="mt-2 border-t pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
												{dim.insight}
											</p>
										</div>
									))}
								</div>
							</div>

							{/* Per-subject Calibration Table */}
							{r.subjectBreakdown.length > 0 && (
								<div>
									<h3 className="mb-1.5 text-xs font-semibold text-foreground">Per-Subject Calibration Breakdown</h3>
									<p className="mb-2 text-[11px] text-muted-foreground">The 30-day Recall estimates weight recent, independent and confirmed answers more heavily. The composite uses up to five points of Recall adjustment. Practice minutes are based on Practice problems.</p>
									<details className="mb-2 text-[11px] text-muted-foreground">
										<summary className="cursor-pointer">How Recall affects the score</summary>
										<p>Confirmed and provisional grades start at weights 1 and 0.5. Independent and unknown help multiply these weights by 1 and 0.5. Assisted answers appear in the observed rates. The weight halves every 14 days and each subject-day contributes at most three units. Each outcome starts with a 0.5 prior.</p>
										<p>A subject can contribute after five eligible answers across at least two days. The adjustment shrinks by W/(W+8), where W is its evidence weight. Matching source IDs exclude Quiz, Mistakes and Recall-FSRS overlap. Older records without a matching ID may still overlap.</p>
									</details>
									<div className="mb-2 flex items-center gap-2 text-[11px]"><span>Recall period:</span><button type="button" aria-pressed={recallRange === "last30"} onClick={() => setRecallRange("last30")} className={cn("rounded border px-2 py-1", recallRange === "last30" && "bg-accent")}>Last 30 days</button><button type="button" aria-pressed={recallRange === "allTime"} onClick={() => setRecallRange("allTime")} className={cn("rounded border px-2 py-1", recallRange === "allTime" && "bg-accent")}>All time</button></div>
									{r.dataCoverage.trackedPropositions < 5 && r.dataCoverage.graphNodes > 10 && (
										<p className="mb-2 text-[11px] text-muted-foreground">
											Tip: Use Flashcards to create reviews from graph concepts ({r.dataCoverage.trackedPropositions}/{r.dataCoverage.graphNodes} currently tracked), or complete a Practice problem to record a review.
										</p>
									)}
									<div className="overflow-x-auto rounded-xl border">
										<table className="w-full text-left text-[11px]">
											<thead className="border-b bg-muted/40 text-muted-foreground">
												<tr>
													<th className="px-2.5 py-1.5 font-medium">Subject</th>
													<th className="px-2 py-1.5 font-medium">Readiness</th>
													<th className="px-2 py-1.5 font-medium">FSRS Ret. / S</th>
													<th className="px-2 py-1.5 font-medium">Diff D</th>
													<th className="px-2 py-1.5 font-medium">Practice solve / est. min</th>
													<th className="px-2 py-1.5 font-medium">Meta Bias</th>
															<th className="px-2 py-1.5 font-medium">Recall evidence</th>
													<th className="px-2.5 py-1.5 font-medium">Pace</th>
												</tr>
											</thead>
											<tbody className="divide-y">
												{r.subjectBreakdown.map((sub) => (
													<tr key={sub.subject} className="hover:bg-muted/20">
														<td className="px-2.5 py-1.5 font-medium text-foreground">{sub.subject}</td>
																<td className="px-2 py-1.5 tabular-nums">{sub.readinessPct}%{sub.readinessBaseline ? " baseline" : ""}{sub.graphConcepts > 0 && <div className="text-muted-foreground">{sub.reviewedConcepts}/{sub.graphConcepts} reviewed</div>}</td>
														<td className="px-2 py-1.5 tabular-nums">
															{sub.retentionPct !== null ? `${sub.retentionPct}%` : "—"}
															{sub.avgStabilityDays !== null ? ` · ${sub.avgStabilityDays}d` : ""}
														</td>
														<td className="px-2 py-1.5 tabular-nums">
															{sub.avgDifficulty !== null ? `${sub.avgDifficulty}` : "—"}
														</td>
														<td className="px-2 py-1.5 tabular-nums">
															{sub.solveRatePct !== null ? `${sub.solveRatePct}%` : "—"}
															{sub.avgMinPerProblem !== null ? ` · ${sub.avgMinPerProblem}m` : ""}
														</td>
														<td className="px-2 py-1.5 tabular-nums">
															{sub.quizBiasPct !== null
																? `${sub.quizBiasPct > 0 ? "+" : ""}${sub.quizBiasPct}%`
																: "—"}
														</td>
															<td className="px-2 py-1.5 tabular-nums">{recallRange === "last30" && sub.recallCapacity && <RecallCapacityEvidence evidence={sub.recallCapacity} />}{sub.recallInsights && sub.recallInsights[recallRange].responses ? <details><summary className="cursor-pointer">{sub.recallInsights[recallRange].responses} answers · {sub.recallInsights[recallRange].assessed} assessed</summary><RecallInsightsDetail insights={sub.recallInsights} range={recallRange} /></details> : "—"}</td>
																<td className="px-2.5 py-1.5 font-medium tabular-nums text-primary">{sub.paceFactor}×{sub.paceBaseline ? " baseline" : ""}</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</div>
							)}

							<details className="rounded-lg border p-3">
								<summary className="cursor-pointer font-medium">Local prediction experiments</summary>
								<p className="my-2 text-muted-foreground">Compares trained forecasts against baselines on later answers. Uses local data and zero model tokens.</p>
								<button type="button" disabled={experimentBusy} onClick={() => void runExperiments()} className="rounded border px-2 py-1 disabled:opacity-40">{experimentBusy ? "Evaluating…" : "Evaluate forecasts"}</button>
								{experiments && <div className="mt-2 space-y-2"><ExperimentResult label="FSRS-6" result={experiments.fsrs} /><ExperimentResult label="Recall" result={experiments.recall} /></div>}
							</details>
							{/* AI Cognitive Interpretation Result */}
							{diagnosis && (
								<div className="rounded-xl border border-primary/30 bg-primary/5 p-3.5">
									<div className="flex items-center justify-between gap-2">
										<span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
											<SparklesIcon className="size-3.5 text-primary" /> AI Neuro-Cognitive Synthesis
										</span>
										<span className="text-[10px] text-muted-foreground">{diagnosis.modelLabel}</span>
									</div>
									<p className="mt-1.5 leading-relaxed text-foreground">{diagnosis.summary}</p>
									{diagnosis.suggestedScore && <div className="mt-2 rounded border p-2">
										<p><strong>AI advisory score {diagnosis.suggestedScore.score}/100</strong> · local composite {r.compositeScore ?? "—"}</p>
										<p>{diagnosis.suggestedScore.reason}</p>
										<div className="flex flex-wrap gap-2">{diagnosis.suggestedScore.evidenceIds.map((id, index) => <button key={id} type="button" onClick={() => { setEvidenceId(id); showTab("recall"); }} className="underline">Review evidence {index + 1}</button>)}</div>
									</div>}
									<div className="mt-2.5 grid gap-2 sm:grid-cols-2">
										<div className="rounded-lg border bg-background/80 p-2.5">
											<div className="font-medium text-success">Cognitive Strengths</div>
											<ul className="mt-1 space-y-0.5 text-[11px] text-foreground">
												{diagnosis.strengths.map((s, i) => (
													<li key={i}>• {s}</li>
												))}
											</ul>
										</div>
										<div className="rounded-lg border bg-background/80 p-2.5">
											<div className="font-medium text-warning">Primary Bottlenecks</div>
											<ul className="mt-1 space-y-0.5 text-[11px] text-foreground">
												{diagnosis.bottlenecks.map((b, i) => (
													<li key={i}>• {b}</li>
												))}
											</ul>
										</div>
									</div>
									{diagnosis.neuroProtocols.length > 0 && (
										<div className="mt-2 rounded-lg border bg-background/80 p-2.5">
											<div className="font-medium text-primary">Recommended Brain-Backed Study Protocols</div>
											<ul className="mt-1 space-y-0.5 text-[11px] text-foreground">
												{diagnosis.neuroProtocols.map((p, i) => (
													<li key={i}>• {p}</li>
												))}
											</ul>
										</div>
									)}
									{diagnosis.suggestedPaceNote && (
										<p className="mt-2 text-[11px] text-muted-foreground">{diagnosis.suggestedPaceNote}</p>
									)}
								</div>
							)}
						</>
					) : null}
					{r && visited.has("audit") && <div hidden={tab !== "audit"}><CapacityRecallAudit onApplied={fetchReport} visible={tab === "audit"} /></div>}
					{r && (visited.has("recall") || visited.has("groups")) && <div hidden={tab !== "recall" && tab !== "groups"}>
						<CapacityRecallAnalysis report={r} onRefresh={fetchReport} section={tab === "groups" ? "groups" : "recall"}
							visible={tab === "recall" || tab === "groups"} evidenceId={evidenceId} onEvidenceOpened={clearEvidenceId} />
					</div>}
				</div>
				{calibration && <div role="dialog" aria-modal="true" aria-label="Calibration preview" className="absolute inset-0 z-[55] flex items-center justify-center bg-black/50 p-4">
					<div className="max-h-[80vh] w-full max-w-xl space-y-3 overflow-auto rounded-xl border bg-card p-4 text-sm shadow-xl">
						<h3 className="font-semibold">Calibrate workload · {calibration.date}</h3>
						<p>Planned study: {calibration.plannedStudyHours === null ? "no saved plan" : `${calibration.plannedStudyHours} h`}. Choose the changes to apply.</p>
						{calibration.proposals.length === 0 && <p className="text-muted-foreground">No upcoming study block has enough current topic evidence for a suggestion.</p>}
						{calibration.proposals.map((item) => <label key={item.id} className="block rounded border p-2">
							<input type="checkbox" checked={selectedChanges.includes(item.id)} onChange={(event) => {
								const checked = event.currentTarget.checked;
								setSelectedChanges((old) => checked ? [...old, item.id] : old.filter((id) => id !== item.id));
							}} /> <strong>{item.subject} · {item.date} · {item.startTime}–{item.endTime}</strong>
							<span className="block">{item.focus.minutes} min · {item.focus.mode === "recheck" ? "Independent self-check" : "Practice incomplete steps"} · {item.focus.topic}</span>
							{item.focus.task && <span className="block text-muted-foreground">{item.focus.task}</span>}
							{item.previous && <span className="block text-muted-foreground">Replaces {item.previous.minutes} min on {item.previous.topic}.</span>}
							<span className="block text-xs text-muted-foreground">{Math.round(item.full * 100)}% estimated full · {item.graded} graded · {item.days} days · {item.provisional} provisional · {item.helpUnknown} help unknown</span>
						</label>)}
						<label className="block rounded border p-2"><input type="checkbox" checked={realism} onChange={(event) => setRealism(event.currentTarget.checked)} /> <strong>Realism for the next generated plan</strong>
							<span className="block">{calibration.realism.current === null ? "Automatic" : `${Math.round(calibration.realism.current * 100)}%`} → {Math.round(calibration.realism.recommended * 100)}%</span>
						</label>
						<div className="flex flex-wrap gap-2">
							<button type="button" onClick={() => setCalibration(null)} className="rounded border px-3 py-1">Close</button>
							{calibration.undoId && <button type="button" disabled={calibrating} onClick={() => void calibrate("undo_calibration")} className="rounded border px-3 py-1">Undo last calibration</button>}
							<button type="button" disabled={calibrating || (!realism && selectedChanges.length === 0)} onClick={() => void calibrate("apply_calibration")} className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-40">Apply selected changes</button>
						</div>
					</div>
				</div>}
				{diagnosisPreview && <div role="dialog" aria-modal="true" aria-label="AI diagnosis preview" className="absolute inset-0 z-[55] flex items-center justify-center bg-black/50 p-4">
					<div className="max-h-[80vh] w-full max-w-2xl space-y-3 overflow-auto rounded-xl border bg-card p-4 text-sm shadow-xl">
						<h3 className="font-semibold">Preview AI diagnosis</h3>
						<p>Model: {diagnosisPreview.modelLabel}</p>
						<p>{diagnosisPreview.estimateUsd === null ? "Token pricing is unavailable for this model." : `Illustrative cost: $${diagnosisPreview.estimateUsd.toFixed(4)}, based on ~${diagnosisPreview.inputTokens} input and ${diagnosisPreview.outputTokens} output tokens. Reasoning and retries can cost more.`}</p>
						<details><summary className="cursor-pointer">Show exact report and instructions to send</summary>
							<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">{JSON.stringify({ instructions: diagnosisPreview.systemPrompt, report: diagnosisPreview.payload, responseSchema: diagnosisPreview.responseSchema }, null, 2)}</pre>
						</details>
						<div className="flex gap-2">
							<button type="button" onClick={() => setDiagnosisPreview(null)} disabled={aiBusy} className="rounded border px-3 py-1">Close</button>
							<button type="button" disabled={aiBusy} onClick={() => void runAiDiagnosis(true)} className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-40">{aiBusy ? "Running…" : "Send and diagnose"}</button>
						</div>
					</div>
				</div>}

				{/* Footer Actions */}
				<div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-5 py-3 text-xs">
					<div className="flex flex-wrap items-center gap-1.5">
						{data?.aiAvailability.availableRoles && data.aiAvailability.availableRoles.length > 0 && (
							<select
								value={selectedRole}
								onChange={(e) => onChangeRole(e.target.value)}
								className="max-w-[175px] truncate rounded-md border bg-background px-2 py-1.5 text-[11px]"
								title="Select AI model for Cognitive Diagnosis"
							>
								<option value="">Auto ({data.aiAvailability.coach.modelLabel ?? "coach"})</option>
								{data.aiAvailability.availableRoles.map((roleOpt) => (
									<option key={roleOpt.role} value={roleOpt.role}>
										{roleOpt.label}: {roleOpt.modelLabel}
									</option>
								))}
							</select>
						)}
						<button
							type="button"
							disabled={aiBusy || loading || !data?.aiAvailability.coach.available}
							onClick={() => void runAiDiagnosis(false)}
							className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 font-medium hover:bg-accent disabled:opacity-40"
						>
							{aiBusy ? <BrailleSpinner /> : <SparklesIcon className="size-3.5 text-primary" />} AI Deep Diagnosis
						</button>
						{r && (
							<button
								type="button"
								onClick={() => {
									onClose();
									onAskCoachWithReport(
										`Dựa trên báo cáo lực học (Composite ${r.compositeScore ?? "—"}/100, Pace ${r.recommendedPaceFactor}×, Brier ${r.metacognition.brierScore ?? "—"}, Bias ${r.metacognition.calibrationBiasPct ?? "—"}%), hãy điều chỉnh lịch học và thói quen cho phù hợp giúp tôi.`,
									);
								}}
								className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-[11px] hover:bg-accent"
							>
								<MessageSquareTextIcon className="size-3 text-primary" /> Discuss in Coach Chat
							</button>
						)}
						{r && <button type="button" onClick={() => { onClose(); onAskCoachWithReport("Hãy phân tích bằng chứng free recall theo từng môn trong báo cáo, phân biệt đúng, đúng một phần và chưa chắc; chỉ ra chủ đề nên luyện tiếp kèm số mẫu và mức độ tin cậy. Không tự sửa lịch hay dữ liệu."); }} className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1.5 text-[11px] hover:bg-accent"><MessageSquareTextIcon className="size-3 text-primary" /> Discuss recall with Coach</button>}
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={calibrating || loading || !r}
							onClick={() => void calibrate("preview_calibration")}
							className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
						>
							{calibrating ? <BrailleSpinner /> : null} Preview Workload Calibration
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

"use client";

import { useCallback, useEffect, useState } from "react";
import type { LearningCapacityReport } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
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

interface CapacityAiDiagnosis {
	summary: string;
	strengths: string[];
	bottlenecks: string[];
	neuroProtocols: string[];
	suggestedPaceNote: string;
	modelLabel: string;
}

interface CapacityResponse {
	report: LearningCapacityReport;
	aiAvailability: {
		coach: { available: boolean; modelLabel: string | null };
		availableRoles?: Array<{ role: string; label: string; modelLabel: string }>;
	};
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
		}
	}, [open, fetchReport]);

	const runAiDiagnosis = async () => {
		setAiBusy(true);
		setErrMsg(null);
		try {
			const res = await fetch("/api/planner/capacity", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "diagnose_ai",
					date,
					...(selectedRole ? { preferredRole: selectedRole } : {}),
				}),
			});
			const body = (await res.json()) as { report?: LearningCapacityReport; diagnosis?: CapacityAiDiagnosis; error?: string };
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			if (body.report && data) setData({ ...data, report: body.report });
			if (body.diagnosis) setDiagnosis(body.diagnosis);
		} catch (e) {
			setErrMsg(e instanceof Error ? e.message : "AI diagnosis failed.");
		} finally {
			setAiBusy(false);
		}
	};

	const applyCalibration = async () => {
		setCalibrating(true);
		setErrMsg(null);
		try {
			const res = await fetch("/api/planner/capacity", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "apply_realism", date }),
			});
			const body = (await res.json()) as { report?: LearningCapacityReport; error?: string };
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			if (body.report && data) setData({ ...data, report: body.report });
			await onSnapshotUpdated();
			setStatusMsg(
				`Đã đồng bộ Realism ${Math.round((body.report?.recommendedRealismFactor ?? 1) * 100)}% và cập nhật lịch hôm nay.`,
			);
		} catch (e) {
			setErrMsg(e instanceof Error ? e.message : "Calibration update failed.");
		} finally {
			setCalibrating(false);
		}
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
								Cognitive &amp; Learning Capacity Diagnostics (&ldquo;Lực học cá nhân&rdquo;)
							</h2>
							<p className="text-[11px] text-muted-foreground">
								Scientific metrics synthesized from FSRS-6 weights, Quiz Brier Calibration, Graph Foundations, Mistakes &amp; Past Sessions
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
							className="rounded-md border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						>
							<XIcon className="size-3.5" />
						</button>
					</div>
				</div>

				{/* Body */}
				<div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
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
					) : r ? (
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
									{r.dataCoverage.trackedPropositions < 5 && r.dataCoverage.graphNodes > 10 && (
										<p className="mb-2 text-[11px] text-muted-foreground">
											Mẹo: Mở tab <strong>FLASHCARDS</strong> chọn các cụm/node Graph để tạo thẻ ôn tập (hiện mới có {r.dataCoverage.trackedPropositions}/{r.dataCoverage.graphNodes} khái niệm có lịch FSRS), hoặc mở Practice từ node Graph để <code>conclude</code> tự ghi điểm FSRS.
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
													<th className="px-2 py-1.5 font-medium">Solve / Min</th>
													<th className="px-2 py-1.5 font-medium">Meta Bias</th>
													<th className="px-2.5 py-1.5 font-medium">Pace</th>
												</tr>
											</thead>
											<tbody className="divide-y">
												{r.subjectBreakdown.map((sub) => (
													<tr key={sub.subject} className="hover:bg-muted/20">
														<td className="px-2.5 py-1.5 font-medium text-foreground">{sub.subject}</td>
														<td className="px-2 py-1.5 tabular-nums">{sub.readinessPct}%</td>
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
														<td className="px-2.5 py-1.5 font-medium tabular-nums text-primary">{sub.paceFactor}×</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								</div>
							)}

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
				</div>

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
							onClick={() => void runAiDiagnosis()}
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
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							disabled={calibrating || loading || !r}
							onClick={() => void applyCalibration()}
							className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
						>
							{calibrating ? <BrailleSpinner /> : null} Apply Calibration to Workload
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

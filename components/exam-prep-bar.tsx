"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
	CalendarIcon,
	CheckIcon,
	FilterIcon,
	GraduationCapIcon,
	PlusIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import type { ExamPrepPatch, ExamPrepStatus, StudyMode, StudyPace } from "@/src/core";

const PACE_LABELS: ReadonlyArray<{ id: StudyPace; label: string; hint: string }> = [
	{ id: "thorough", label: "Thorough", hint: "Full proofs & deep understanding" },
	{ id: "efficient", label: "Efficient", hint: "Focused core proofs & due concepts" },
	{ id: "crash-course", label: "Crash", hint: "High-yield exam tactics & speed" },
];

export function ExamPrepSidebarCard() {
	const router = useRouter();
	const [status, setStatus] = useState<ExamPrepStatus | null>(null);
	const [editing, setEditing] = useState(false);
	const [scopeOpen, setScopeOpen] = useState(false);
	const [draftTitle, setDraftTitle] = useState("");
	const [draftDate, setDraftDate] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(() => {
		if (typeof fetch !== "function") return;
		fetch("/api/exam-prep", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<ExamPrepStatus>) : null))
			.then((data) => {
				if (!data) return;
				setStatus(data);
				setDraftTitle(data.config.examTitle);
				setDraftDate(data.config.examDate ?? "");
			})
			.catch(() => {
				/* ignore when offline or during test mocks */
			});
	}, []);

	useEffect(() => {
		load();
		if (typeof window === "undefined") return;
		const onFocus = () => load();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [load]);

	const patchConfig = async (patch: ExamPrepPatch) => {
		setSaving(true);
		try {
			const res = await fetch("/api/exam-prep", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (res.ok) {
				const data = (await res.json()) as ExamPrepStatus;
				setStatus(data);
				setDraftTitle(data.config.examTitle);
				setDraftDate(data.config.examDate ?? "");
			}
		} catch {
			/* best-effort update */
		} finally {
			setSaving(false);
		}
	};

	const mode: StudyMode = status?.config.mode ?? "long-term";
	const pace: StudyPace = status?.config.pace ?? "thorough";
	const readiness = status?.examReadinessPct ?? 0;
	const days = status?.daysRemaining ?? null;
	const selectedClusterIds = new Set(status?.config.clusterIds ?? []);
	const availableScopes = status?.availableScopes ?? [];
	const activeScopeLabels = status?.activeScopeLabels ?? [];
	const exams = status?.config.exams ?? [];
	const activeExamId = status?.config.activeExamId ?? null;

	const countdownText =
		days === null
			? null
			: days > 0
				? `D-${days}`
				: days === 0
					? "Today"
					: `+${Math.abs(days)}d`;

	const scopeSummary =
		activeScopeLabels.length > 0
			? activeScopeLabels.length === 1
				? activeScopeLabels[0]!
				: `${activeScopeLabels[0]} +${activeScopeLabels.length - 1}`
			: availableScopes.length > 0
				? `All subjects (${status?.totalNodeCount ?? 0})`
				: `All nodes (${status?.totalNodeCount ?? 0})`;

	const toggleCluster = (id: string) => {
		const next = new Set(selectedClusterIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		void patchConfig({ clusterIds: [...next] });
	};

	const startNewExam = () => {
		const title = draftTitle.trim() || (activeScopeLabels[0] ? `${activeScopeLabels[0]} Exam` : "New Exam");
		void patchConfig({
			mode: "exam",
			upsertExam: {
				title,
				date: draftDate || null,
				pace: pace === "thorough" ? "efficient" : pace,
				clusterIds: [...selectedClusterIds],
			},
		});
		setEditing(true);
		setScopeOpen(true);
	};

	return (
		<div
			data-testid="kronoharness-exam-card"
			className="mx-3 mb-2 rounded-lg border bg-background/50 p-2 text-[11px] text-foreground"
		>
			<div className="flex items-center justify-between gap-1.5">
				<span className="inline-flex items-center gap-1 font-medium tracking-tight text-foreground">
					{mode === "exam" ? (
						<GraduationCapIcon className="size-3.5 text-warning" />
					) : (
						<SparklesIcon className="size-3.5 text-success" />
					)}
					<span>ChronoHarness</span>
				</span>
				<span
					className="tabular-nums text-[10px] text-muted-foreground"
					title="FSRS-6 weighted recall readiness across selected scope. Untracked & due nodes lower this percentage — select a specific subject below for per-course readiness."
				>
					Readiness {readiness}%
				</span>
			</div>

			<div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full transition-all duration-300 ${
						readiness >= 80 ? "bg-success" : readiness >= 55 ? "bg-warning" : "bg-error"
					}`}
					style={{ width: `${Math.min(100, Math.max(4, readiness))}%` }}
				/>
			</div>

			<div className="mt-1.5 flex items-center justify-between gap-1">
				<button
					type="button"
					onClick={() => setScopeOpen((v) => !v)}
					className={`inline-flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
						activeScopeLabels.length > 0
							? "border-foreground/30 bg-accent font-medium text-foreground"
							: "border-border/70 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
					}`}
					title="Filter readiness & Exam Prep by subject cluster"
				>
					<FilterIcon className="size-2.5 shrink-0" />
					<span className="truncate">{scopeSummary}</span>
				</button>
				{activeScopeLabels.length > 0 && (
					<button
						type="button"
						disabled={saving}
						onClick={() => void patchConfig({ clusterIds: [] })}
						className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
						title="Reset to all subjects"
					>
						All
					</button>
				)}
			</div>

			{scopeOpen && (
				<div className="mt-1.5 space-y-1.5 rounded-md border border-border/70 bg-background/70 p-1.5">
					{availableScopes.length > 0 ? (
						<div className="max-h-32 space-y-0.5 overflow-y-auto pr-0.5">
							{availableScopes.map((sc) => {
								const checked = selectedClusterIds.has(sc.id);
								return (
									<button
										key={sc.id}
										type="button"
										disabled={saving}
										onClick={() => toggleCluster(sc.id)}
										className={`flex w-full items-center justify-between gap-1.5 rounded px-1 py-0.5 text-left text-[10px] transition-colors ${
											checked
												? "bg-accent font-medium text-foreground"
												: "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
										}`}
									>
										<span className="inline-flex min-w-0 items-center gap-1">
											<span
												className={`inline-flex size-3 shrink-0 items-center justify-center rounded border ${
													checked ? "border-foreground bg-foreground text-background" : "border-border"
												}`}
											>
												{checked && <CheckIcon className="size-2" />}
											</span>
											<span className="truncate">{sc.label}</span>
										</span>
										<span className="shrink-0 font-mono text-[9px] tabular-nums opacity-80">
											{sc.nodeCount} · {sc.readinessPct}%
										</span>
									</button>
								);
							})}
						</div>
					) : (
						<p className="text-[10px] text-muted-foreground">
							Subject clusters appear once a lesson adds graph nodes.
						</p>
					)}
				</div>
			)}

			<div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-0.5">
				<button
					type="button"
					disabled={saving}
					onClick={() => void patchConfig({ mode: "long-term" })}
					className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
						mode === "long-term"
							? "bg-background text-foreground shadow-xs"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					Long-Term
				</button>
				<button
					type="button"
					disabled={saving}
					onClick={() => void patchConfig({ mode: "exam" })}
					className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
						mode === "exam"
							? "bg-background text-foreground shadow-xs"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					Exam Prep
				</button>
			</div>

			<div className="mt-1.5 flex items-center gap-1">
				{PACE_LABELS.map((item) => (
					<button
						key={item.id}
						type="button"
						disabled={saving}
						title={item.hint}
						onClick={() => void patchConfig({ pace: item.id })}
						className={`flex-1 rounded border px-1 py-0.5 text-[10px] transition-colors ${
							pace === item.id
								? "border-foreground/40 bg-accent font-medium text-foreground"
								: "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
						}`}
					>
						{item.label}
					</button>
				))}
			</div>

			{(status?.weakFoundationNames?.length || status?.duePropositionNames?.length) ? (
				<div
					data-testid="kronoharness-priority-review"
					className="mt-1.5 space-y-0.5 border-t pt-1.5 text-[10px] text-muted-foreground"
				>
					{status.weakFoundationNames.length > 0 && (
						<p className="truncate" title={status.weakFoundationNames.join(", ")}>
							<span className="font-medium text-error">Weak roots:</span>{" "}
							{status.weakFoundationNames.slice(0, 2).join(", ")}
							{status.weakFoundationNames.length > 2 ? ` +${status.weakFoundationNames.length - 2}` : ""}
						</p>
					)}
					{status.duePropositionNames.length > 0 && (
						<p className="truncate" title={status.duePropositionNames.join(", ")}>
							<span className="font-medium text-warning">Due ({status.dueCount}):</span>{" "}
							{status.duePropositionNames.slice(0, 2).join(", ")}
							{status.duePropositionNames.length > 2 ? ` +${status.duePropositionNames.length - 2}` : ""}
						</p>
					)}
				</div>
			) : null}

			{mode === "exam" && (
				<div className="mt-1.5 border-t pt-1.5">
					{exams.length > 0 && (
						<div className="mb-1.5 flex flex-wrap items-center gap-1">
							{exams.map((ex) => {
								const isActive = ex.id === activeExamId;
								return (
									<span
										key={ex.id}
										className={`inline-flex max-w-full items-center gap-0.5 rounded border px-1 py-0.5 text-[9px] ${
											isActive
												? "border-foreground/40 bg-accent font-medium text-foreground"
												: "border-border/70 text-muted-foreground"
										}`}
									>
										<button
											type="button"
											disabled={saving}
											onClick={() => void patchConfig({ selectExamId: ex.id, mode: "exam" })}
											className="truncate max-w-[110px]"
											title={`${ex.title}${ex.date ? ` (${ex.date})` : ""}`}
										>
											{ex.title}
										</button>
										<button
											type="button"
											disabled={saving}
											onClick={() => void patchConfig({ deleteExamId: ex.id })}
											className="opacity-60 hover:opacity-100"
											title="Remove saved exam"
										>
											<Trash2Icon className="size-2.5" />
										</button>
									</span>
								);
							})}
							<button
								type="button"
								disabled={saving}
								onClick={startNewExam}
								className="inline-flex items-center gap-0.5 rounded border border-dashed border-border px-1 py-0.5 text-[9px] text-muted-foreground hover:text-foreground"
								title="Save current settings as a new Exam profile"
							>
								<PlusIcon className="size-2.5" />
								New
							</button>
						</div>
					)}

					<div className="flex items-center justify-between gap-1.5">
						<button
							type="button"
							onClick={() => setEditing((v) => !v)}
							className="inline-flex min-w-0 items-center gap-1 truncate text-[10px] text-muted-foreground hover:text-foreground"
							title="Set exam title, date, and subject scope"
						>
							<CalendarIcon className="size-3 shrink-0" />
							<span className="truncate">
								{status?.config.examTitle || "Set exam details"}
							</span>
						</button>
						<div className="flex shrink-0 items-center gap-1">
							{countdownText && (
								<span className="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-warning">
									{countdownText}
								</span>
							)}
							<button
								type="button"
								onClick={() => router.push("/chat/new?mode=practice&drill=1")}
								className="rounded border px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent"
								title="Start targeted Practice pre-loaded with this exam's due & weak propositions"
							>
								Drill
							</button>
						</div>
					</div>
					{editing && (
						<div className="mt-1.5 flex flex-col gap-1">
							<input
								type="text"
								value={draftTitle}
								onChange={(e) => setDraftTitle(e.target.value)}
								placeholder="Exam title (e.g. XSTK Midterm)"
								className="h-6 rounded border bg-background px-1.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
							/>
							<div className="flex items-center gap-1">
								<input
									type="date"
									value={draftDate}
									onChange={(e) => setDraftDate(e.target.value)}
									className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-[10px] outline-none focus:ring-1 focus:ring-ring"
								/>
								<button
									type="button"
									disabled={saving}
									onClick={() => {
										const title = draftTitle.trim();
										if (!activeExamId && title) {
											void patchConfig({
												mode: "exam",
												upsertExam: {
													title,
													date: draftDate || null,
													pace,
													clusterIds: [...selectedClusterIds],
												},
											});
										} else {
											void patchConfig({
												examTitle: title,
												examDate: draftDate || null,
											});
										}
										setEditing(false);
									}}
									className="h-6 rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground"
								>
									Save
								</button>
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
	CalendarIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	FilterIcon,
	GraduationCapIcon,
	PencilIcon,
	PlusIcon,
	SparklesIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import type { ExamPrepPatch, ExamPrepStatus, StudyMode, StudyPace } from "@/src/core";
import { useServerEvent } from "@/components/server-events";

const COLLAPSE_STORAGE_KEY = "chronoharness.examCardCollapsed";

const PACE_LABELS: ReadonlyArray<{ id: StudyPace; label: string; hint: string }> = [
	{ id: "thorough", label: "Thorough", hint: "Full proofs & deep understanding" },
	{ id: "efficient", label: "Efficient", hint: "Core proofs, 1-2 checks/node & due roots" },
	{ id: "crash-course", label: "Crash", hint: "Key idea + cue + 1 check/node, skip deep proofs" },
];

export function ExamPrepSidebarCard() {
	const router = useRouter();
	const [status, setStatus] = useState<ExamPrepStatus | null>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [editing, setEditing] = useState(false);
	const [creatingNew, setCreatingNew] = useState(false);
	const [scopeOpen, setScopeOpen] = useState(false);
	const [draftTitle, setDraftTitle] = useState("");
	const [draftDate, setDraftDate] = useState("");
	const [draftClusterIds, setDraftClusterIds] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		try {
			if (typeof window !== "undefined" && window.localStorage?.getItem(COLLAPSE_STORAGE_KEY) === "1") {
				setCollapsed(true);
			}
		} catch {
			/* ignore storage errors */
		}
	}, []);

	const toggleCollapsed = () => {
		setCollapsed((prev) => {
			const next = !prev;
			try {
				window.localStorage?.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
			} catch {
				/* ignore storage errors */
			}
			return next;
		});
	};

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

	useServerEvent("planner-changed", load);

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

	const activeClusterSet = new Set(creatingNew ? draftClusterIds : (status?.config.clusterIds ?? []));
	const draftScopeLabels = creatingNew
		? availableScopes.filter((s) => activeClusterSet.has(s.id)).map((s) => s.label)
		: activeScopeLabels;

	const scopeSummary =
		draftScopeLabels.length > 0
			? draftScopeLabels.length === 1
				? draftScopeLabels[0]!
				: `${draftScopeLabels[0]} +${draftScopeLabels.length - 1}`
			: availableScopes.length > 0
				? `All subjects (${status?.totalNodeCount ?? 0})`
				: `All nodes (${status?.totalNodeCount ?? 0})`;

	const toggleCluster = (id: string) => {
		const next = new Set(activeClusterSet);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		if (creatingNew) {
			setDraftClusterIds([...next]);
			return;
		}
		void patchConfig({ clusterIds: [...next] });
	};

	const startNewExam = () => {
		setCreatingNew(true);
		setEditing(true);
		setScopeOpen(true);
		setDraftTitle("");
		setDraftDate("");
		setDraftClusterIds([...selectedClusterIds]);
	};

	const cancelNewExam = () => {
		setCreatingNew(false);
		setEditing(false);
		setDraftTitle(status?.config.examTitle ?? "");
		setDraftDate(status?.config.examDate ?? "");
		setDraftClusterIds([]);
	};

	const saveExamForm = () => {
		const fallbackTitle =
			draftScopeLabels.length === 1
				? `${draftScopeLabels[0]} Exam`
				: `Exam ${exams.length + 1}`;
		const title = draftTitle.trim() || (creatingNew ? fallbackTitle : "");
		if (creatingNew || (!activeExamId && title)) {
			const clusters = creatingNew ? draftClusterIds : [...selectedClusterIds];
			void patchConfig({
				mode: "exam",
				upsertExam: {
					title: title || fallbackTitle,
					date: draftDate || null,
					pace,
					clusterIds: clusters,
				},
			});
		} else {
			void patchConfig({
				examTitle: title,
				examDate: draftDate || null,
			});
		}
		setCreatingNew(false);
		setEditing(false);
		setScopeOpen(false);
	};

	const deleteCurrentExam = () => {
		if (activeExamId) {
			void patchConfig({ deleteExamId: activeExamId });
		} else {
			void patchConfig({ clearExam: true });
		}
		setCreatingNew(false);
		setEditing(false);
		setScopeOpen(false);
	};

	const paceLabel = PACE_LABELS.find((p) => p.id === pace)?.label ?? "Thorough";
	const collapsedLabel =
		mode === "exam" && status?.config.examTitle
			? status.config.examTitle
			: `ChronoHarness · ${paceLabel}`;

	return (
		<div
			data-testid="kronoharness-exam-card"
			className="mx-3 mb-1.5 rounded-lg border bg-background/50 p-1.5 text-[11px] text-foreground"
		>
			<div className="flex items-center justify-between gap-1">
				<button
					type="button"
					onClick={toggleCollapsed}
					aria-expanded={!collapsed}
					className="inline-flex min-w-0 flex-1 items-center gap-1 text-left font-medium tracking-tight text-foreground hover:opacity-80"
					title={collapsed ? "Expand ChronoHarness panel" : "Collapse ChronoHarness panel to show more chats"}
				>
					{mode === "exam" ? (
						<GraduationCapIcon className="size-3.5 shrink-0 text-warning" />
					) : (
						<SparklesIcon className="size-3.5 shrink-0 text-success" />
					)}
					<span className="truncate text-[10.5px]">{collapsed ? collapsedLabel : "ChronoHarness"}</span>
				</button>
				<div className="flex shrink-0 items-center gap-1">
					{collapsed && mode === "exam" && countdownText && (
						<span className="rounded bg-warning/15 px-1 py-0.5 font-mono text-[9px] font-semibold leading-none text-warning">
							{countdownText}
						</span>
					)}
					<span
						className="tabular-nums text-[10px] text-muted-foreground"
						title="FSRS-6 weighted recall readiness across selected scope. Untracked & due nodes lower this percentage — select a specific subject below for per-course readiness."
					>
						{collapsed ? `${readiness}%` : `Readiness ${readiness}%`}
					</span>
					<button
						type="button"
						onClick={toggleCollapsed}
						aria-label={collapsed ? "Expand ChronoHarness panel" : "Collapse ChronoHarness panel"}
						className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						title={collapsed ? "Expand ChronoHarness panel" : "Collapse ChronoHarness panel"}
					>
						{collapsed ? <ChevronDownIcon className="size-3" /> : <ChevronUpIcon className="size-3" />}
					</button>
				</div>
			</div>

			<div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full transition-all duration-300 ${
						readiness >= 80 ? "bg-success" : readiness >= 55 ? "bg-warning" : "bg-error"
					}`}
					style={{ width: `${Math.min(100, Math.max(4, readiness))}%` }}
				/>
			</div>

			{!collapsed && (
				<>
					<div className="mt-1.5 flex items-center justify-between gap-1">
						<button
							type="button"
							onClick={() => setScopeOpen((v) => !v)}
							className={`inline-flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
								draftScopeLabels.length > 0
									? "border-foreground/30 bg-accent font-medium text-foreground"
									: "border-border/70 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
							}`}
							title="Filter readiness & Exam Prep by subject cluster"
						>
							<FilterIcon className="size-2.5 shrink-0" />
							<span className="truncate">{scopeSummary}</span>
							{scopeOpen ? (
								<ChevronUpIcon className="size-2.5 shrink-0 opacity-70" />
							) : (
								<ChevronDownIcon className="size-2.5 shrink-0 opacity-70" />
							)}
						</button>
						{draftScopeLabels.length > 0 && (
							<button
								type="button"
								disabled={saving}
								onClick={() => {
									if (creatingNew) setDraftClusterIds([]);
									else void patchConfig({ clusterIds: [] });
								}}
								className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
								title="Reset to all subjects"
							>
								All
							</button>
						)}
					</div>

					{scopeOpen && (
						<div className="mt-1 space-y-1 rounded-md border border-border/70 bg-background/70 p-1">
							<div className="flex items-center justify-between gap-1 px-0.5 text-[9px] text-muted-foreground">
								<span>{creatingNew ? "Subjects for new exam:" : "Filter subjects:"}</span>
								<button
									type="button"
									onClick={() => setScopeOpen(false)}
									className="font-medium text-foreground hover:underline"
								>
									Done
								</button>
							</div>
							{availableScopes.length > 0 ? (
								<div className="max-h-24 space-y-0.5 overflow-y-auto pr-0.5">
									{availableScopes.map((sc) => {
										const checked = activeClusterSet.has(sc.id);
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

					<div className="mt-1.5 grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-0.5">
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

					<div className="mt-1 flex items-center gap-1">
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

					{status?.weakFoundationNames?.length || status?.duePropositionNames?.length ? (
						<div
							data-testid="kronoharness-priority-review"
							className="mt-1 border-t pt-1 text-[9.5px] text-muted-foreground"
						>
							<p
								className="truncate"
								title={[
									status.weakFoundationNames.length > 0
										? `Weak roots (${status.weakFoundationsCount}): ${status.weakFoundationNames.join(", ")}`
										: "",
									status.duePropositionNames.length > 0
										? `Due (${status.dueCount}): ${status.duePropositionNames.join(", ")}`
										: "",
								]
									.filter(Boolean)
									.join(" | ")}
							>
								{status.weakFoundationNames.length > 0 && (
									<>
										<span className="font-medium text-error">Weak:</span>{" "}
										<span>{status.weakFoundationNames[0]}</span>
									</>
								)}
								{status.weakFoundationNames.length > 0 && status.duePropositionNames.length > 0 && (
									<span> · </span>
								)}
								{status.duePropositionNames.length > 0 && (
									<>
										<span className="font-medium text-warning">Due ({status.dueCount}):</span>{" "}
										<span>{status.duePropositionNames[0]}</span>
									</>
								)}
							</p>
						</div>
					) : null}

					{mode === "exam" && (
						<div className="mt-1 border-t pt-1">
							<div className="flex items-center gap-1">
								{exams.length > 0 && !creatingNew ? (
									<select
										aria-label="Select exam profile"
										disabled={saving}
										value={activeExamId ?? ""}
										onChange={(e) => {
											const nextId = e.target.value;
											if (!nextId) return;
											setCreatingNew(false);
											setEditing(false);
											void patchConfig({ selectExamId: nextId, mode: "exam" });
										}}
										className="h-6 min-w-0 flex-1 rounded border bg-background px-1 text-[10px] font-medium outline-none focus:ring-1 focus:ring-ring"
										title="Switch saved exam profile"
									>
										{!activeExamId && <option value="">Select exam...</option>}
										{exams.map((ex) => (
											<option key={ex.id} value={ex.id}>
												{ex.title}
												{ex.date ? ` (${ex.date})` : ""}
											</option>
										))}
									</select>
								) : (
									<button
										type="button"
										onClick={() => {
											if (creatingNew) cancelNewExam();
											else setEditing((v) => !v);
										}}
										className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-[10px] text-muted-foreground hover:text-foreground"
										title="Set exam title, date, and subject scope"
									>
										<CalendarIcon className="size-3 shrink-0" />
										<span className="truncate">
											{creatingNew ? "New exam profile" : status?.config.examTitle || "Set exam details"}
										</span>
									</button>
								)}
								{!creatingNew && countdownText && (
									<span className="shrink-0 rounded bg-warning/15 px-1 py-0.5 font-mono text-[9.5px] font-semibold text-warning">
										{countdownText}
									</span>
								)}
								<button
									type="button"
									onClick={() => router.push("/chat/new?mode=practice&drill=1")}
									className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent"
									title="Start targeted Practice pre-loaded with this exam's due & weak propositions"
								>
									Drill
								</button>
							</div>

							<div className="mt-1 flex items-center justify-between gap-1 text-[9.5px] text-muted-foreground">
								<button
									type="button"
									disabled={saving}
									onClick={startNewExam}
									className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
									title="Create a new subject-scoped Exam profile"
								>
									<PlusIcon className="size-2.5" />
									New
								</button>
								<div className="flex items-center gap-1">
									<button
										type="button"
										disabled={saving}
										onClick={() => {
											if (creatingNew) cancelNewExam();
											else setEditing((v) => !v);
										}}
										className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
										title="Edit exam title, date, and subjects"
									>
										<PencilIcon className="size-2.5" />
										{editing && !creatingNew ? "Close" : "Edit"}
									</button>
									{(activeExamId || status?.config.examTitle || status?.config.examDate) && (
										<button
											type="button"
											disabled={saving}
											aria-label="Delete current exam"
											onClick={deleteCurrentExam}
											className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-error/10 hover:text-error"
											title="Delete this exam profile"
										>
											<Trash2Icon className="size-2.5" />
											Delete
										</button>
									)}
								</div>
							</div>

							{editing && (
								<div className="mt-1 flex flex-col gap-1 border-t pt-1">
									<div className="flex items-center justify-between gap-1 text-[9px] text-muted-foreground">
										<span className="truncate">
											Scope: <strong className="font-medium text-foreground">{scopeSummary}</strong>
										</span>
										<button
											type="button"
											onClick={() => setScopeOpen((v) => !v)}
											className="shrink-0 underline hover:text-foreground"
										>
											{scopeOpen ? "Hide subjects" : "Choose subject"}
										</button>
									</div>
									<input
										type="text"
										value={draftTitle}
										onChange={(e) => setDraftTitle(e.target.value)}
										placeholder="Exam title (e.g. Đại số OLP)"
										className="h-6 rounded border bg-background px-1.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
									/>
									<div className="flex items-center gap-1">
										<input
											type="date"
											value={draftDate}
											onChange={(e) => setDraftDate(e.target.value)}
											className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 text-[10px] outline-none focus:ring-1 focus:ring-ring"
										/>
										{creatingNew && (
											<button
												type="button"
												disabled={saving}
												onClick={cancelNewExam}
												className="h-6 rounded border px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
												title="Cancel creating exam"
											>
												<XIcon className="size-3" />
											</button>
										)}
										<button
											type="button"
											disabled={saving}
											onClick={saveExamForm}
											className="h-6 rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground"
										>
											Save
										</button>
									</div>
								</div>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

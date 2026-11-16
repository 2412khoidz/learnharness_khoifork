"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import Link from "next/link";
import {
	addDaysToDate,
	daysBetweenDates,
	WEEKDAY_LABELS,
	WEEKDAYS,
	type CognitiveLoad,
	type DailyHabitLog,
	type DailyStudyPlan,
	type FixedEventCategory,
	type FixedWeeklyEvent,
	type LifestyleConfig,
	type MilestoneKind,
	type PeakFocusWindow,
	type PlannedBlock,
	type PlannerConfig,
	type PlannerEngineMode,
	type PlannerIntensity,
	type PlannerPersonalSignals,
	type StudyMilestone,
	type SyllabusTopic,
	type Weekday,
} from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { BrailleSpinner } from "@/components/braille-spinner";
import { useServerEvent } from "@/components/server-events";
import { cn } from "@/lib/utils";
import {
	ArrowUpRightIcon,
	CalendarClockIcon,
	CheckCircle2Icon,
	CircleIcon,
	CpuIcon,
	FlameIcon,
	HeartPulseIcon,
	ImagePlusIcon,
	MoonIcon,
	PlusIcon,
	RefreshCwIcon,
	ScaleIcon,
	SparklesIcon,
	TrashIcon,
	WandSparklesIcon,
} from "lucide-react";

interface PlannerSnapshot {
	config: PlannerConfig;
	plan: DailyStudyPlan;
	signals: PlannerPersonalSignals;
	aiAvailability: {
		coach: { available: boolean; modelLabel: string | null };
		vision: { available: boolean; modelLabel: string | null };
		research: { available: boolean; modelLabel: string | null; webSearch: boolean };
	};
}

type PlannerTab = "today" | "milestones" | "tkb" | "lifestyle";

const KIND_BADGE: Record<MilestoneKind, string> = {
	competition: "border-warning/40 bg-warning/10 text-warning",
	exam: "border-error/40 bg-error/10 text-error",
	project: "border-primary/40 bg-primary/10 text-primary",
	deadline: "border-success/40 bg-success/10 text-success",
};

const BLOCK_STYLE: Record<PlannedBlock["type"], string> = {
	study: "border-l-4 border-l-primary bg-card",
	break: "border-l-4 border-l-warning/70 bg-muted/40",
	hobby: "border-l-4 border-l-success/70 bg-success/5",
	meal: "border-l-4 border-l-border bg-muted/25",
	fixed: "border-l-4 border-l-muted-foreground/40 bg-muted/35",
	sleep: "border-l-4 border-l-primary/50 bg-primary/5",
};

function formatMinCompact(min: number): string {
	const h = Math.floor(min / 60);
	const m = min % 60;
	if (h === 0) return `${m}m`;
	if (m === 0) return `${h}h`;
	return `${h}h ${m}m`;
}

export function PlannerPage() {
	const [snap, setSnap] = useState<PlannerSnapshot | null>(null);
	const [tab, setTab] = useState<PlannerTab>("today");
	const [busy, setBusy] = useState(false);
	const [aiNote, setAiNote] = useState("");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/planner", { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setSnap((await res.json()) as PlannerSnapshot);
			setErrorMsg(null);
		} catch (e) {
			setErrorMsg(e instanceof Error ? e.message : "Could not load planner.");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	useServerEvent("planner-changed", load);

	const patchPlanner = useCallback(async (patch: Partial<PlannerConfig>) => {
		setBusy(true);
		setErrorMsg(null);
		try {
			const res = await fetch("/api/planner", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			const body = (await res.json()) as PlannerSnapshot & { error?: string };
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			setSnap(body);
		} catch (e) {
			setErrorMsg(e instanceof Error ? e.message : "Failed to save planner settings.");
		} finally {
			setBusy(false);
		}
	}, []);

	const generatePlan = useCallback(
		async (overrideMode?: PlannerEngineMode) => {
			setBusy(true);
			setErrorMsg(null);
			try {
				const res = await fetch("/api/planner/generate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mode: overrideMode ?? snap?.config.engineMode ?? "local",
						focusNote: aiNote.trim() || undefined,
					}),
				});
				const body = (await res.json()) as PlannerSnapshot & { error?: string };
				if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
				setSnap(body);
			} catch (e) {
				setErrorMsg(e instanceof Error ? e.message : "Schedule generation failed.");
			} finally {
				setBusy(false);
			}
		},
		[aiNote, snap?.config.engineMode],
	);

	const checkIn = useCallback(async (payload: Record<string, unknown>) => {
		setErrorMsg(null);
		try {
			const res = await fetch("/api/planner/checkin", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = (await res.json()) as PlannerSnapshot & { error?: string };
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			setSnap(body);
		} catch (e) {
			setErrorMsg(e instanceof Error ? e.message : "Check-in failed.");
		}
	}, []);

	const todayLog: DailyHabitLog | undefined = snap ? snap.config.logs[snap.plan.date] : undefined;

	return (
		<div className="flex h-dvh flex-col" data-testid="planner-page">
			<TopBar>
				<span className="flex items-center gap-1.5 font-ui text-sm font-medium">
					<CalendarClockIcon className="size-4 text-primary" /> Study Planner
				</span>
				{snap && (
					<div className="ml-auto flex flex-wrap items-center gap-2">
						{/* Engine mode toggle: Local TS (0 tokens) vs AI Smart Planner */}
						<div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-xs" role="group" aria-label="Planning engine">
							<button
								type="button"
								data-testid="planner-engine-local"
								disabled={busy}
								onClick={() => void patchPlanner({ engineMode: "local" }).then(() => generatePlan("local"))}
								className={cn(
									"inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
									snap.config.engineMode === "local"
										? "bg-card font-medium text-foreground shadow-xs"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<CpuIcon className="size-3" /> Local · 0 tokens
							</button>
							<button
								type="button"
								data-testid="planner-engine-llm"
								disabled={busy}
								onClick={() => void patchPlanner({ engineMode: "llm" })}
								title={snap.aiAvailability.coach.available ? `Uses ${snap.aiAvailability.coach.modelLabel}` : "Configure a model in Settings -> Models"}
								className={cn(
									"inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
									snap.config.engineMode === "llm"
										? "bg-card font-medium text-foreground shadow-xs"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<SparklesIcon className="size-3 text-primary" /> AI Coach
							</button>
						</div>

						{/* Intensity selector */}
						<div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-xs" role="group" aria-label="Study intensity">
							{(
								[
									{ id: "healthy", label: "Healthy", icon: HeartPulseIcon },
									{ id: "balanced", label: "Balanced", icon: ScaleIcon },
									{ id: "intensive", label: "Intensive", icon: FlameIcon },
								] as const
							).map(({ id, label, icon: Icon }) => (
								<button
									key={id}
									type="button"
									data-testid={`planner-intensity-${id}`}
									disabled={busy}
									onClick={() => void patchPlanner({ intensity: id })}
									className={cn(
										"inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
										snap.config.intensity === id
											? "bg-card font-medium text-foreground shadow-xs"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									<Icon className="size-3" /> {label}
								</button>
							))}
						</div>

						<button
							type="button"
							data-testid="planner-generate-btn"
							disabled={busy}
							onClick={() => void generatePlan()}
							className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
						>
							{busy ? <BrailleSpinner /> : <RefreshCwIcon className="size-3.5" />}
							{snap.config.engineMode === "llm" ? "Plan with AI" : "Recompute"}
						</button>
					</div>
				)}
			</TopBar>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 sm:px-6">
					{errorMsg && (
						<div role="alert" className="flex items-center justify-between rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
							<span>{errorMsg}</span>
							<button type="button" onClick={() => setErrorMsg(null)} className="underline">
								Dismiss
							</button>
						</div>
					)}

					{!snap ? (
						<div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
							<BrailleSpinner /> Loading Study Planner...
						</div>
					) : (
						<>
							{/* Top summary & sleep/habit strip */}
							<div className="grid gap-3 md:grid-cols-3">
								<div className="rounded-xl border bg-card p-3.5">
									<div className="flex items-center justify-between text-xs text-muted-foreground">
										<span>Daily Study Target ({snap.plan.date})</span>
										<span className="inline-flex items-center gap-1.5">
											{snap.plan.habitStrength && (
												<span
													className="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"
													title="Smooth Habit Score (exponential smoothing — missing 1 day decays gently instead of resetting to 0)"
												>
													Habit {snap.plan.habitStrength.overallPct}%
												</span>
											)}
											<span className="rounded border px-1.5 py-0.5 text-[10px] uppercase">
												{snap.plan.engineUsed === "llm" ? snap.plan.modelUsed ?? "AI" : "Local 0-token"}
											</span>
										</span>
									</div>
									<div className="mt-1.5 flex items-baseline gap-2">
										<span className="text-2xl font-semibold tracking-tight">{snap.plan.minDailyStudyHours}h+</span>
										<span className="text-xs text-muted-foreground">
											planned {snap.plan.plannedStudyHours}h · free {snap.plan.freeHoursTotal}h
										</span>
									</div>
									<div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
										<button
											type="button"
											onClick={() => void checkIn({ date: snap.plan.date, mealsOk: !todayLog?.mealsOk })}
											className={cn(
												"rounded-md border px-2 py-1 transition-colors",
												todayLog?.mealsOk ? "border-success/40 bg-success/10 text-success" : "text-muted-foreground hover:bg-accent",
											)}
										>
											{todayLog?.mealsOk ? "✓ Meals OK" : "Meals OK"}
										</button>
										<button
											type="button"
											onClick={() => void checkIn({ date: snap.plan.date, hobbyDone: !todayLog?.hobbyDone })}
											className={cn(
												"rounded-md border px-2 py-1 transition-colors",
												todayLog?.hobbyDone ? "border-success/40 bg-success/10 text-success" : "text-muted-foreground hover:bg-accent",
											)}
										>
											{todayLog?.hobbyDone ? "✓ Hobby Done" : "Hobby / Rest"}
										</button>
										<span className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
											Energy:
											{([1, 2, 3, 4, 5] as const).map((lvl) => (
												<button
													key={lvl}
													type="button"
													onClick={() => void checkIn({ date: snap.plan.date, energyScore: lvl })}
													className={cn(
														"rounded px-1.5 py-0.5 text-[11px]",
														todayLog?.energyScore === lvl ? "bg-primary text-primary-foreground" : "hover:bg-accent",
													)}
												>
													{lvl}
												</button>
											))}
										</span>
									</div>
								</div>

								<div className="rounded-xl border bg-card p-3.5">
									<div className="flex items-center justify-between text-xs text-muted-foreground">
										<span className="inline-flex items-center gap-1"><MoonIcon className="size-3.5 text-primary" /> Sleep Anchor Recovery</span>
										<span>
											Wake ~{snap.plan.todayWakeTime}
											{snap.plan.habitStrength && snap.plan.habitStrength.circadianDriftMin > 0
												? ` · Drift ±${snap.plan.habitStrength.circadianDriftMin}m`
												: ""}
										</span>
									</div>
									<div className="mt-1.5 text-sm font-medium text-foreground">
										Tonight: sleep by <span className="text-primary">{snap.plan.recommendedBedtime}</span>
									</div>
									<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{snap.plan.sleepShiftAdvice}</p>
									{snap.plan.habitStrength && snap.plan.habitStrength.cycleWakeSuggestions.length > 0 && (
										<p className="mt-1 text-[11px] text-muted-foreground">
											90m cycle wakes: {snap.plan.habitStrength.cycleWakeSuggestions.slice(0, 2).join(" · ")}
										</p>
									)}
									<div className="mt-2 flex items-center gap-2 text-xs">
										<label className="text-[11px] text-muted-foreground">Log slept at:</label>
										<input
											type="time"
											value={todayLog?.actualBedtime ?? snap.config.lifestyle.sleep.currentBedtime}
											onChange={(e) => void checkIn({ date: snap.plan.date, actualBedtime: e.target.value })}
											className="rounded border bg-background px-1.5 py-0.5 text-xs"
										/>
										<button
											type="button"
											onClick={() => setTab("lifestyle")}
											className="ml-auto text-[11px] text-primary hover:underline"
										>
											Tune sleep →
										</button>
									</div>
								</div>

								<div className="rounded-xl border bg-card p-3.5">
									<div className="flex items-center justify-between text-xs text-muted-foreground">
										<span>Personal Context & Coach</span>
										<span>{snap.signals.examPrep.examReadinessPct}% graph ready</span>
									</div>
									{snap.plan.coachSummary ? (
										<p className="mt-1.5 text-xs leading-relaxed text-foreground">{snap.plan.coachSummary}</p>
									) : (
										<p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
											{snap.signals.subjectSignals.length > 0
												? `${snap.signals.subjectSignals.reduce((a, s) => a + s.dueCount, 0)} FSRS cards due · ${snap.signals.subjectSignals.reduce((a, s) => a + s.weakCount, 0)} weak foundations tracked.`
												: "Add exams, competitions, or weekly fixed events to tailor your study quotas."}
											{snap.signals.mistakeHints?.recentRules[0]
												? ` Top mistake rule: "${snap.signals.mistakeHints.recentRules[0]}"`
												: ""}
										</p>
									)}
									{snap.config.engineMode === "llm" && (
										<div className="mt-2 flex gap-1.5">
											<input
												type="text"
												value={aiNote}
												onChange={(e) => setAiNote(e.target.value)}
												placeholder="Optional AI note (e.g. mệt buổi tối, ưu tiên Giải tích)..."
												className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
											/>
										</div>
									)}
								</div>
							</div>

							{/* Sub-tabs */}
							<div className="flex flex-wrap items-center gap-1 border-b pb-2 text-xs">
								{(
									[
										{ id: "today", label: "Today & Quotas" },
										{ id: "milestones", label: `Milestones & Exams (${snap.config.milestones.length})` },
										{ id: "tkb", label: `Weekly TKB (${snap.config.fixedEvents.length})` },
										{ id: "lifestyle", label: "Habits, Hobbies & Sleep" },
									] as const
								).map((t) => (
									<button
										key={t.id}
										type="button"
										data-testid={`planner-tab-${t.id}`}
										onClick={() => setTab(t.id)}
										className={cn(
											"rounded-md px-3 py-1.5 transition-colors",
											tab === t.id
												? "bg-primary font-medium text-primary-foreground"
												: "text-muted-foreground hover:bg-accent hover:text-foreground",
										)}
									>
										{t.label}
									</button>
								))}
							</div>

							{tab === "today" && (
								<TodayQuotasTab snap={snap} todayLog={todayLog} onCheckIn={checkIn} />
							)}
							{tab === "milestones" && (
								<MilestonesTab
									snap={snap}
									busy={busy}
									onSaveMilestones={(milestones) => patchPlanner({ milestones })}
									onError={setErrorMsg}
								/>
							)}
							{tab === "tkb" && (
								<WeeklyTkbTab
									snap={snap}
									busy={busy}
									onSaveFixedEvents={(fixedEvents) => patchPlanner({ fixedEvents })}
									onError={setErrorMsg}
								/>
							)}
							{tab === "lifestyle" && (
								<LifestyleTab
									snap={snap}
									busy={busy}
									onSaveLifestyle={(lifestyle) => patchPlanner({ lifestyle })}
								/>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function TodayQuotasTab({
	snap,
	todayLog,
	onCheckIn,
}: {
	snap: PlannerSnapshot;
	todayLog: DailyHabitLog | undefined;
	onCheckIn: (payload: Record<string, unknown>) => Promise<void>;
}) {
	const completedBlocks = new Set(todayLog?.completedBlockIds ?? []);
	const completedChecks = new Set(todayLog?.completedChecklistIds ?? []);
	const loggedBySubj = todayLog?.loggedStudyMinBySubject ?? {};
	const autoPendingEntries = Object.entries(snap.signals.autoTrackedStudyMinBySubject ?? {})
		.map(([subj, autoMin]) => ({ subj, delta: autoMin - (loggedBySubj[subj] ?? 0) }))
		.filter((item) => item.delta >= 5);

	return (
		<div className="grid gap-4 lg:grid-cols-12">
			{/* Daily Subject Quotas + Checklist */}
			<div className="flex flex-col gap-3 lg:col-span-5">
				{snap.plan.weeklyForecast && snap.plan.weeklyForecast.length > 0 && (
					<div className="rounded-xl border bg-card p-3">
						<div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
							<span>7-Day Workload Forecast</span>
							<span>Free vs Target</span>
						</div>
						<div className="grid grid-cols-7 gap-1 text-center text-[10px]">
							{snap.plan.weeklyForecast.map((day) => (
								<div
									key={day.date}
									className={cn(
										"rounded-md border px-1 py-1",
										day.date === snap.plan.date && "border-primary bg-primary/5",
										day.loadLevel === "heavy" && "border-warning/40 bg-warning/10",
									)}
									title={day.milestoneTitles.length > 0 ? `Due: ${day.milestoneTitles.join(", ")}` : `${day.freeHours}h free`}
								>
									<div className="font-medium text-muted-foreground">{WEEKDAY_LABELS[day.weekday]}</div>
									<div className="mt-0.5 tabular-nums font-semibold text-foreground">{day.plannedHours}h</div>
								</div>
							))}
						</div>
					</div>
				)}
				{autoPendingEntries.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-[11px]">
						<span className="text-muted-foreground">Session activity today:</span>
						{autoPendingEntries.map(({ subj, delta }) => (
							<button
								key={subj}
								type="button"
								onClick={() => void onCheckIn({ date: snap.plan.date, addStudyMin: { subject: subj, minutes: delta } })}
								className="rounded-md border border-primary/40 bg-card px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-accent"
							>
								+{delta}m {subj}
							</button>
						))}
					</div>
				)}
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-medium">Daily Quotas & Checklist</h2>
					<span className="text-xs text-muted-foreground">{snap.plan.quotas.length} active subjects</span>
				</div>
				{snap.plan.quotas.map((q) => {
					const doneMin = loggedBySubj[q.subject] ?? 0;
					const pct = Math.min(100, Math.round((doneMin / Math.max(1, q.targetMin)) * 100));
					const studyTopic = encodeURIComponent(`${q.subject}: ${q.checklist[0]?.text ?? "focused review"}`);
					return (
						<div key={q.id} className="rounded-xl border bg-card p-3.5">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<div className="flex items-center gap-1.5">
										<span className="truncate text-sm font-medium">{q.subject}</span>
										{q.paceMultiplier && q.paceMultiplier !== 1 && (
											<span
												className="rounded border border-primary/30 bg-primary/10 px-1 py-0 text-[10px] tabular-nums text-primary"
												title="DueCue adaptive pace multiplier from past study logs"
											>
												Pace ×{q.paceMultiplier}
											</span>
										)}
									</div>
									{q.weaknessSummary && (
										<div className="mt-0.5 text-[11px] text-muted-foreground">{q.weaknessSummary}</div>
									)}
								</div>
								<Link
									href={`/chat/new?topic=${studyTopic}`}
									className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent"
								>
									Study <ArrowUpRightIcon className="size-3" />
								</Link>
							</div>
							<div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
								<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
									<div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
								</div>
								<span className="tabular-nums text-[11px]">
									{formatMinCompact(doneMin)} / {formatMinCompact(q.targetMin)}
								</span>
							</div>
							<ul className="mt-2.5 flex flex-col gap-1.5">
								{q.checklist.map((item) => {
									const isDone = completedChecks.has(item.id);
									return (
										<li key={item.id}>
											<button
												type="button"
												onClick={() => void onCheckIn({ date: snap.plan.date, toggleChecklistId: item.id })}
												className={cn(
													"flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent/60",
													isDone && "text-muted-foreground line-through",
												)}
											>
												{isDone ? (
													<CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-success" />
												) : (
													<CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
												)}
												<span>{item.text}</span>
											</button>
										</li>
									);
								})}
							</ul>
						</div>
					);
				})}
			</div>

			{/* Chronological Time-blocks */}
			<div className="flex flex-col gap-2.5 lg:col-span-7">
				<div className="flex items-center justify-between">
					<h2 className="text-sm font-medium">Today's Time-Blocked Schedule</h2>
					<span className="text-xs text-muted-foreground">Soft-strict subject switch enabled</span>
				</div>
				<div className="flex flex-col gap-2">
					{snap.plan.blocks.map((blk) => {
						const isDone = completedBlocks.has(blk.id);
						const canToggle = blk.type === "study" || blk.type === "hobby" || blk.type === "sleep";
						return (
							<div
								key={blk.id}
								className={cn(
									"flex items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-opacity",
									BLOCK_STYLE[blk.type],
									isDone && "opacity-60",
								)}
							>
								<div className="w-24 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
									{blk.startTime}–{blk.endTime}
								</div>
								<div className="min-w-0 flex-1">
									<div className={cn("truncate text-sm font-medium", isDone && "line-through")}>
										{blk.title}
									</div>
									{(blk.reason || blk.cognitiveLoad) && (
										<div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
											{blk.cognitiveLoad && (
												<span className="rounded border px-1 py-0 text-[10px] uppercase">
													{blk.cognitiveLoad}
												</span>
											)}
											{blk.reason && <span>{blk.reason}</span>}
										</div>
									)}
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{blk.type === "study" && (
										<Link
											href={`/chat/new?topic=${encodeURIComponent(blk.actionTopic || blk.subject || blk.title)}`}
											className="rounded-md border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent"
										>
											Start
										</Link>
									)}
									{canToggle && (
										<button
											type="button"
											onClick={() => void onCheckIn({ date: snap.plan.date, toggleBlockId: blk.id })}
											aria-label={isDone ? `Unmark ${blk.title}` : `Complete ${blk.title}`}
											className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
										>
											{isDone ? (
												<CheckCircle2Icon className="size-4 text-success" />
											) : (
												<CircleIcon className="size-4" />
											)}
										</button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function MilestonesTab({
	snap,
	busy,
	onSaveMilestones,
	onError,
}: {
	snap: PlannerSnapshot;
	busy: boolean;
	onSaveMilestones: (milestones: StudyMilestone[]) => Promise<void>;
	onError: (msg: string) => void;
}) {
	const [kind, setKind] = useState<MilestoneKind>("competition");
	const [title, setTitle] = useState("");
	const [subject, setSubject] = useState("");
	const [dueDate, setDueDate] = useState(() => addDaysToDate(snap.plan.date, 14));
	const [priority, setPriority] = useState<1 | 2 | 3>(3);
	const [load, setLoad] = useState<CognitiveLoad>("heavy");
	const [hours, setHours] = useState(20);
	const [notes, setNotes] = useState("");
	const [topics, setTopics] = useState<SyllabusTopic[]>([]);
	const [sourceSummary, setSourceSummary] = useState("");
	const [researching, setResearching] = useState(false);

	const runAiResearch = async (preferLocal = false) => {
		const effectiveTitle = title.trim() || notes.split(/\r?\n/)[0]?.trim() || "";
		if (!effectiveTitle) return onError("Enter an exam, competition, or project name (or syllabus outline) first.");
		if (!title.trim()) setTitle(effectiveTitle.slice(0, 80));
		setResearching(true);
		try {
			const res = await fetch("/api/planner/research-exam", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: effectiveTitle, kind, dueDate, materialsText: notes, preferLocal }),
			});
			const body = (await res.json()) as {
				error?: string;
				subject?: string;
				cognitiveLoad?: CognitiveLoad;
				priority?: 1 | 2 | 3;
				estimatedHours?: number;
				syllabusTopics?: SyllabusTopic[];
				sourceSummary?: string;
			};
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			if (body.subject) setSubject(body.subject);
			if (body.cognitiveLoad) setLoad(body.cognitiveLoad);
			if (body.priority) setPriority(body.priority);
			if (body.estimatedHours) setHours(body.estimatedHours);
			if (body.syllabusTopics) setTopics(body.syllabusTopics);
			if (body.sourceSummary) setSourceSummary(body.sourceSummary);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Syllabus research failed.");
		} finally {
			setResearching(false);
		}
	};

	const onPickMaterialFile = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") return;
			const content = reader.result.slice(0, 8000);
			if (file.name.toLowerCase().endsWith(".ics")) {
				const sumMatch = /^SUMMARY(?:;[^:]*)?:(.+)$/im.exec(content);
				const dtMatch = /^DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})/im.exec(content);
				if (sumMatch && !title.trim()) setTitle(sumMatch[1]!.trim().slice(0, 100));
				if (dtMatch) setDueDate(`${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}`);
			}
			setNotes((prev) => (prev.trim() ? `${prev.trim()}\n${content}` : content));
		};
		reader.readAsText(file);
		e.target.value = "";
	};

	const addMilestone = async () => {
		if (!title.trim()) return;
		const next: StudyMilestone = {
			id: `ms_${Date.now()}`,
			kind,
			title: title.trim(),
			subject: subject.trim() || title.trim(),
			dueDate,
			priority,
			cognitiveLoad: load,
			clusterIds: [],
			estimatedHours: Number(hours) || 10,
			completedHours: 0,
			syllabusTopics: topics,
			notes: notes.trim(),
			...(sourceSummary ? { sourceSummary } : {}),
		};
		await onSaveMilestones([...snap.config.milestones, next]);
		setTitle("");
		setSubject("");
		setNotes("");
		setTopics([]);
		setSourceSummary("");
	};

	const toggleTopicDone = async (msId: string, topicId: string) => {
		const next = snap.config.milestones.map((m) =>
			m.id !== msId
				? m
				: {
					...m,
					syllabusTopics: m.syllabusTopics.map((t) => (t.id === topicId ? { ...t, done: !t.done } : t)),
				},
		);
		await onSaveMilestones(next);
	};

	const sorted = useMemo(
		() => [...snap.config.milestones].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
		[snap.config.milestones],
	);

	// 28-day mini horizon calendar starting today
	const horizonDays = useMemo(() => {
		const byDate = new Map<string, StudyMilestone[]>();
		for (const m of sorted) {
			const list = byDate.get(m.dueDate) ?? [];
			list.push(m);
			byDate.set(m.dueDate, list);
		}
		return Array.from({ length: 28 }, (_, i) => {
			const date = addDaysToDate(snap.plan.date, i);
			return { date, dayNum: date.slice(8), items: byDate.get(date) ?? [] };
		});
	}, [snap.plan.date, sorted]);

	return (
		<div className="grid gap-4 lg:grid-cols-12">
			<div className="flex flex-col gap-3 lg:col-span-7">
				{/* Compact 4-week milestone calendar strip */}
				<div className="rounded-xl border bg-card p-3.5">
					<div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
						<span>Next 28 Days — Exam, Competition & Deadline Markers</span>
						<span>Today: {snap.plan.date}</span>
					</div>
					<div className="grid grid-cols-7 gap-1 text-center text-[11px]">
						{horizonDays.map((cell) => (
							<div
								key={cell.date}
								className={cn(
									"flex min-h-11 flex-col items-center justify-between rounded-md border p-1",
									cell.date === snap.plan.date && "border-primary bg-primary/5",
									cell.items.length > 0 && "border-warning/50 bg-warning/10",
								)}
								title={cell.items.map((x) => `${x.title} (${x.kind})`).join(", ")}
							>
								<span className="tabular-nums text-[10px] text-muted-foreground">{cell.dayNum}</span>
								{cell.items.length > 0 ? (
									<span className="w-full truncate rounded bg-primary/15 px-1 text-[9px] font-medium text-foreground">
										{cell.items[0]!.title}
									</span>
								) : (
									<span className="h-2" />
								)}
							</div>
						))}
					</div>
				</div>

				{/* Milestone list */}
				{sorted.length === 0 ? (
					<div className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
						No exams, competitions, or project deadlines added yet. Add one on the right!
					</div>
				) : (
					sorted.map((m) => {
						const dLeft = daysBetweenDates(snap.plan.date, m.dueDate);
						const pct = Math.min(100, Math.round((m.completedHours / Math.max(1, m.estimatedHours)) * 100));
						return (
							<div key={m.id} className="rounded-xl border bg-card p-3.5">
								<div className="flex items-start justify-between gap-2">
									<div>
										<div className="flex flex-wrap items-center gap-1.5">
											<span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase", KIND_BADGE[m.kind])}>
												{m.kind}
											</span>
											<span className="text-sm font-medium">{m.title}</span>
											<span className="text-xs text-muted-foreground">
												({dLeft >= 0 ? `D-${dLeft}` : `Overdue ${Math.abs(dLeft)}d`})
											</span>
										</div>
										<div className="mt-1 text-xs text-muted-foreground">
											Subject: {m.subject} · Due {m.dueDate} · {m.completedHours}/{m.estimatedHours}h ({pct}%) · {m.cognitiveLoad}
										</div>
									</div>
									<button
										type="button"
										disabled={busy}
										onClick={() => void onSaveMilestones(snap.config.milestones.filter((x) => x.id !== m.id))}
										className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
										title="Remove milestone"
									>
										<TrashIcon className="size-3.5" />
									</button>
								</div>
								{m.sourceSummary && (
									<p className="mt-1.5 text-[11px] text-muted-foreground">{m.sourceSummary}</p>
								)}
								{m.syllabusTopics.length > 0 && (
									<div className="mt-2.5 flex flex-wrap gap-1.5">
										{m.syllabusTopics.map((t) => (
											<button
												key={t.id}
												type="button"
												onClick={() => void toggleTopicDone(m.id, t.id)}
												className={cn(
													"inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors",
													t.done ? "bg-muted text-muted-foreground line-through" : "hover:bg-accent",
												)}
											>
												{t.title} ({t.estHours}h)
											</button>
										))}
									</div>
								)}
							</div>
						);
					})
				)}
			</div>

			{/* Add & AI Research Form */}
			<div className="rounded-xl border bg-card p-4 lg:col-span-5">
				<h3 className="text-sm font-medium">Add Exam / Competition / Project</h3>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Enter manually or run 1-shot AI syllabus estimation once (saved statically).
				</p>
				<div className="mt-3 flex flex-col gap-2.5 text-xs">
					<div className="grid grid-cols-2 gap-2">
						<div>
							<label className="mb-1 block text-muted-foreground">Type</label>
							<select
								value={kind}
								onChange={(e) => setKind(e.target.value as MilestoneKind)}
								className="w-full rounded-md border bg-background px-2 py-1.5"
							>
								<option value="competition">Competition (Olympic/Contest)</option>
								<option value="exam">Exam / Midterm / Final</option>
								<option value="project">Project</option>
								<option value="deadline">Deadline / Submission</option>
							</select>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Date</label>
							<input
								type="date"
								value={dueDate}
								onChange={(e) => setDueDate(e.target.value)}
								className="w-full rounded-md border bg-background px-2 py-1.5"
							/>
						</div>
					</div>
					<div>
						<label className="mb-1 block text-muted-foreground">Exam / Competition Title</label>
						<input
							type="text"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="e.g. Olympic Giải tích Sinh viên"
							className="w-full rounded-md border bg-background px-2.5 py-1.5"
						/>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<div>
							<label className="mb-1 block text-muted-foreground">Subject Label</label>
							<input
								type="text"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
								placeholder="e.g. Giải tích"
								className="w-full rounded-md border bg-background px-2.5 py-1.5"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Est. Workload (hours)</label>
							<input
								type="number"
								min={1}
								max={500}
								value={hours}
								onChange={(e) => setHours(Number(e.target.value) || 1)}
								className="w-full rounded-md border bg-background px-2.5 py-1.5"
							/>
						</div>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<div>
							<label className="mb-1 block text-muted-foreground">Cognitive Load</label>
							<select
								value={load}
								onChange={(e) => setLoad(e.target.value as CognitiveLoad)}
								className="w-full rounded-md border bg-background px-2 py-1.5"
							>
								<option value="heavy">Heavy (Peak focus)</option>
								<option value="medium">Medium</option>
								<option value="light">Light</option>
							</select>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Priority</label>
							<select
								value={priority}
								onChange={(e) => setPriority(Number(e.target.value) as 1 | 2 | 3)}
								className="w-full rounded-md border bg-background px-2 py-1.5"
							>
								<option value={3}>High (3)</option>
								<option value={2}>Medium (2)</option>
								<option value={1}>Normal (1)</option>
							</select>
						</div>
					</div>
					<div>
						<div className="mb-1 flex items-center justify-between">
							<label className="text-muted-foreground">Materials / Syllabus Notes (optional)</label>
							<label className="cursor-pointer text-[11px] text-primary hover:underline">
								Upload .md / .txt / .ics
								<input type="file" accept=".md,.txt,.ics" onChange={onPickMaterialFile} className="hidden" />
							</label>
						</div>
						<textarea
							rows={3}
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							placeholder="Paste đề cương, tên giáo trình hoặc các chương cần ôn..."
							className="w-full rounded-md border bg-background px-2.5 py-1.5"
						/>
					</div>
					<div className="flex flex-wrap gap-2 pt-1">
						<button
							type="button"
							disabled={researching || !notes.trim()}
							onClick={() => void runAiResearch(true)}
							className="inline-flex items-center justify-center gap-1 rounded-md border px-2.5 py-1.5 font-medium hover:bg-accent disabled:opacity-40"
						>
							Parse Outline (0 tokens)
						</button>
						<button
							type="button"
							disabled={researching || !title.trim()}
							onClick={() => void runAiResearch(false)}
							className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border bg-muted/50 px-3 py-1.5 font-medium hover:bg-accent disabled:opacity-40"
						>
							{researching ? <BrailleSpinner /> : <WandSparklesIcon className="size-3.5 text-primary" />}
							Auto-Research Syllabus (AI)
						</button>
						<button
							type="button"
							disabled={busy || !title.trim()}
							onClick={() => void addMilestone()}
							className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
						>
							<PlusIcon className="size-3.5" /> Add
						</button>
					</div>
					{topics.length > 0 && (
						<div className="mt-1 rounded-lg border bg-muted/30 p-2">
							<div className="mb-1 text-[11px] font-medium">Preview Researched Topics ({topics.length}):</div>
							<ul className="space-y-0.5 text-[11px] text-muted-foreground">
								{topics.map((t) => (
									<li key={t.id}>• {t.title} (~{t.estHours}h)</li>
								))}
							</ul>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function WeeklyTkbTab({
	snap,
	busy,
	onSaveFixedEvents,
	onError,
}: {
	snap: PlannerSnapshot;
	busy: boolean;
	onSaveFixedEvents: (events: FixedWeeklyEvent[]) => Promise<void>;
	onError: (msg: string) => void;
}) {
	const [day, setDay] = useState<Weekday>("mon");
	const [startTime, setStartTime] = useState("07:30");
	const [endTime, setEndTime] = useState("09:30");
	const [title, setTitle] = useState("");
	const [category, setCategory] = useState<FixedEventCategory>("class");

	const [rawText, setRawText] = useState("");
	const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
	const [parsing, setParsing] = useState(false);

	const addManual = async () => {
		if (!title.trim()) return;
		const next: FixedWeeklyEvent = {
			id: `fix_${Date.now()}`,
			dayOfWeek: day,
			startTime,
			endTime,
			title: title.trim(),
			category,
		};
		await onSaveFixedEvents([...snap.config.fixedEvents, next]);
		setTitle("");
	};

	const parseAndImport = async (preferLocal: boolean, overrideText?: string) => {
		const textToUse = overrideText ?? rawText;
		setParsing(true);
		try {
			const res = await fetch("/api/planner/parse-schedule", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					rawText: textToUse,
					imageDataUrl: preferLocal ? undefined : imageDataUrl,
					preferLocal,
				}),
			});
			const body = (await res.json()) as { error?: string; events?: FixedWeeklyEvent[] };
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			const imported = body.events ?? [];
			if (imported.length === 0) throw new Error("No valid weekly blocks were extracted.");
			await onSaveFixedEvents([...snap.config.fixedEvents, ...imported]);
			setRawText("");
			setImageDataUrl(null);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Could not parse schedule.");
		} finally {
			setParsing(false);
		}
	};

	const onPickScheduleFile = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const isIcs = file.name.toLowerCase().endsWith(".ics") || file.type === "text/calendar";
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") return;
			if (isIcs) {
				setImageDataUrl(null);
				setRawText(reader.result);
				void parseAndImport(true, reader.result);
			} else {
				setImageDataUrl(reader.result);
			}
		};
		if (isIcs) {
			reader.readAsText(file);
		} else {
			reader.readAsDataURL(file);
		}
		e.target.value = "";
	};

	return (
		<div className="flex flex-col gap-4">
			{/* Dual Manual Add + AI/Local Import */}
			<div className="grid gap-4 lg:grid-cols-2">
				<div className="rounded-xl border bg-card p-4">
					<h3 className="text-sm font-medium">Method 1: Add to Weekly Grid (Manual · 0 tokens)</h3>
					<div className="mt-3 grid grid-cols-2 gap-2 text-xs">
						<select
							value={day}
							onChange={(e) => setDay(e.target.value as Weekday)}
							className="rounded-md border bg-background px-2 py-1.5"
						>
							{WEEKDAYS.map((d) => (
								<option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>
							))}
						</select>
						<select
							value={category}
							onChange={(e) => setCategory(e.target.value as FixedEventCategory)}
							className="rounded-md border bg-background px-2 py-1.5"
						>
							<option value="class">Class / Lecture</option>
							<option value="club">Club / Team</option>
							<option value="work">Part-time / Lab</option>
							<option value="commute">Commute</option>
							<option value="other">Other</option>
						</select>
						<input
							type="time"
							value={startTime}
							onChange={(e) => setStartTime(e.target.value)}
							className="rounded-md border bg-background px-2 py-1.5"
						/>
						<input
							type="time"
							value={endTime}
							onChange={(e) => setEndTime(e.target.value)}
							className="rounded-md border bg-background px-2 py-1.5"
						/>
					</div>
					<div className="mt-2 flex gap-2 text-xs">
						<input
							type="text"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Course or fixed commitment title..."
							className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5"
						/>
						<button
							type="button"
							disabled={busy || !title.trim()}
							onClick={() => void addManual()}
							className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-40"
						>
							<PlusIcon className="size-3.5" /> Add
						</button>
					</div>
				</div>

				<div className="rounded-xl border bg-card p-4">
					<h3 className="text-sm font-medium">Method 2: Paste Text / .ics Calendar or Upload TKB Photo</h3>
					<textarea
						rows={2}
						value={rawText}
						onChange={(e) => setRawText(e.target.value)}
						placeholder="e.g. T2 07:30-09:30 Giải tích 2, T4 14h-16h30 CLB Thuật toán (or paste .ics)"
						className="mt-2.5 w-full rounded-md border bg-background px-2.5 py-1.5 text-xs"
					/>
					<div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
						<label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 hover:bg-accent">
							<ImagePlusIcon className="size-3.5 text-muted-foreground" />
							<span>{imageDataUrl ? "Photo attached" : "Upload .ics or TKB photo"}</span>
							<input type="file" accept=".ics,text/calendar,image/*" onChange={onPickScheduleFile} className="hidden" />
						</label>
						{rawText.trim() && !imageDataUrl && (
							<button
								type="button"
								disabled={parsing}
								onClick={() => void parseAndImport(true)}
								className="rounded-md border px-2.5 py-1.5 hover:bg-accent disabled:opacity-40"
							>
								Parse Text (0 tokens)
							</button>
						)}
						<button
							type="button"
							disabled={parsing || (!rawText.trim() && !imageDataUrl)}
							onClick={() => void parseAndImport(false)}
							className="ml-auto inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-40"
						>
							{parsing ? <BrailleSpinner /> : <SparklesIcon className="size-3.5" />}
							Import with AI
						</button>
					</div>
				</div>
			</div>

			{/* 7-day weekly grid */}
			<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
				{WEEKDAYS.map((d) => {
					const items = snap.config.fixedEvents
						.filter((ev) => ev.dayOfWeek === d)
						.sort((a, b) => a.startTime.localeCompare(b.startTime));
					return (
						<div key={d} className="flex flex-col gap-1.5 rounded-xl border bg-card p-2.5">
							<div className="border-b pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								{WEEKDAY_LABELS[d]}
							</div>
							{items.length === 0 ? (
								<div className="py-4 text-center text-[11px] text-muted-foreground/60">Free</div>
							) : (
								items.map((ev) => (
									<div key={ev.id} className="group relative rounded-lg border bg-muted/40 p-2 text-xs">
										<div className="text-[10px] font-medium tabular-nums text-muted-foreground">
											{ev.startTime}–{ev.endTime}
										</div>
										<div className="mt-0.5 truncate font-medium">{ev.title}</div>
										<button
											type="button"
											onClick={() =>
												void onSaveFixedEvents(snap.config.fixedEvents.filter((x) => x.id !== ev.id))
											}
											aria-label={`Remove ${ev.title}`}
											className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
										>
											<TrashIcon className="size-3" />
										</button>
									</div>
								))
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function LifestyleTab({
	snap,
	busy,
	onSaveLifestyle,
}: {
	snap: PlannerSnapshot;
	busy: boolean;
	onSaveLifestyle: (lifestyle: LifestyleConfig) => Promise<void>;
}) {
	const [draft, setDraft] = useState<LifestyleConfig>(snap.config.lifestyle);
	const [newHobby, setNewHobby] = useState("");

	useEffect(() => {
		setDraft(snap.config.lifestyle);
	}, [snap.config.lifestyle]);

	const recentLogs = useMemo(
		() => Object.values(snap.config.logs).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7),
		[snap.config.logs],
	);

	const addHobby = () => {
		const trimmed = newHobby.trim();
		if (!trimmed || draft.hobbies.includes(trimmed)) return;
		setDraft({ ...draft, hobbies: [...draft.hobbies, trimmed] });
		setNewHobby("");
	};

	return (
		<div className="grid gap-4 lg:grid-cols-12">
			<div className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-xs lg:col-span-7">
				<div>
					<h3 className="text-sm font-medium">Sleep Anchor & Recovery</h3>
					<p className="mt-0.5 text-muted-foreground">
						Pulls skewed late-night sleep back gradually by your chosen daily step instead of an impossible sudden jump.
					</p>
					<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
						<div>
							<label className="mb-1 block text-muted-foreground">Current Bedtime</label>
							<input
								type="time"
								value={draft.sleep.currentBedtime}
								onChange={(e) => setDraft({ ...draft, sleep: { ...draft.sleep, currentBedtime: e.target.value } })}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Target Bedtime</label>
							<input
								type="time"
								value={draft.sleep.targetBedtime}
								onChange={(e) => setDraft({ ...draft, sleep: { ...draft.sleep, targetBedtime: e.target.value } })}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Sleep Goal (hrs)</label>
							<input
								type="number"
								step="0.5"
								min={5}
								max={10}
								value={draft.sleep.targetSleepHours}
								onChange={(e) =>
									setDraft({ ...draft, sleep: { ...draft.sleep, targetSleepHours: Number(e.target.value) || 7.5 } })
								}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Shift Step (min/day)</label>
							<input
								type="number"
								min={10}
								max={90}
								step={5}
								value={draft.sleep.shiftStepMinPerDay}
								onChange={(e) =>
									setDraft({ ...draft, sleep: { ...draft.sleep, shiftStepMinPerDay: Number(e.target.value) || 30 } })
								}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
					</div>
				</div>

				<div className="border-t pt-3">
					<h3 className="text-sm font-medium">Hobbies, Entertainment & Discipline</h3>
					<div className="mt-2 flex flex-wrap gap-1.5">
						{draft.hobbies.map((h) => (
							<span key={h} className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-0.5">
								{h}
								<button
									type="button"
									onClick={() => setDraft({ ...draft, hobbies: draft.hobbies.filter((x) => x !== h) })}
									className="text-muted-foreground hover:text-destructive"
								>
									×
								</button>
							</span>
						))}
					</div>
					<div className="mt-2 flex gap-2">
						<input
							type="text"
							value={newHobby}
							onChange={(e) => setNewHobby(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addHobby())}
							placeholder="Add custom hobby (e.g. Badminton, Anime, Guitar)..."
							className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1"
						/>
						<button type="button" onClick={addHobby} className="rounded-md border px-2.5 py-1 hover:bg-accent">
							Add
						</button>
					</div>
					<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
						<div>
							<label className="mb-1 block text-muted-foreground">Hobby Budget (m)</label>
							<input
								type="number"
								min={0}
								max={240}
								step={15}
								value={draft.dailyHobbyMin}
								onChange={(e) => setDraft({ ...draft, dailyHobbyMin: Number(e.target.value) || 0 })}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Focus Block (m)</label>
							<input
								type="number"
								min={25}
								max={120}
								step={5}
								value={draft.blockDurationMin}
								onChange={(e) => setDraft({ ...draft, blockDurationMin: Number(e.target.value) || 50 })}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Break Gap (m)</label>
							<input
								type="number"
								min={5}
								max={30}
								step={5}
								value={draft.breakDurationMin}
								onChange={(e) => setDraft({ ...draft, breakDurationMin: Number(e.target.value) || 10 })}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Peak Focus</label>
							<select
								value={draft.sleep.peakFocusWindow}
								onChange={(e) =>
									setDraft({ ...draft, sleep: { ...draft.sleep, peakFocusWindow: e.target.value as PeakFocusWindow } })
								}
								className="w-full rounded-md border bg-background px-2 py-1"
							>
								<option value="auto">Auto (from wake)</option>
								<option value="morning">Morning</option>
								<option value="afternoon">Afternoon</option>
								<option value="evening">Evening</option>
							</select>
						</div>
					</div>
					<label className="mt-3 flex items-center gap-2 text-xs text-foreground">
						<input
							type="checkbox"
							checked={draft.strictSwitchWarning}
							onChange={(e) => setDraft({ ...draft, strictSwitchWarning: e.target.checked })}
						/>
						Enable soft-strict subject switch prompt when a study block finishes
					</label>
				</div>

				<div className="flex justify-end border-t pt-3">
					<button
						type="button"
						disabled={busy}
						onClick={() => void onSaveLifestyle(draft)}
						className="rounded-md bg-primary px-4 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
					>
						Save Lifestyle & Recompute Plan
					</button>
				</div>
			</div>

			<div className="rounded-xl border bg-card p-4 text-xs lg:col-span-5">
				{snap.plan.habitStrength && (
					<div className="mb-4 border-b pb-3.5">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-medium">Smooth Habit Strength</h3>
							<span className="text-xs font-semibold tabular-nums text-success">{snap.plan.habitStrength.overallPct}%</span>
						</div>
						<div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
							<div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
								<div className="text-muted-foreground">Sleep</div>
								<div className="font-semibold tabular-nums">{snap.plan.habitStrength.sleepPct}%</div>
							</div>
							<div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
								<div className="text-muted-foreground">Study</div>
								<div className="font-semibold tabular-nums">{snap.plan.habitStrength.studyPct}%</div>
							</div>
							<div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
								<div className="text-muted-foreground">Meals</div>
								<div className="font-semibold tabular-nums">{snap.plan.habitStrength.mealsPct}%</div>
							</div>
							<div className="rounded-lg border bg-muted/30 px-2 py-1.5 text-center">
								<div className="text-muted-foreground">Hobby</div>
								<div className="font-semibold tabular-nums">{snap.plan.habitStrength.hobbyPct}%</div>
							</div>
						</div>
						<p className="mt-2 text-[11px] leading-snug text-muted-foreground">
							Exponential smoothing (uhabits): missing a day decays gently (~5%) instead of resetting your streak to 0.
						</p>
					</div>
				)}
				<h3 className="text-sm font-medium">Recent 7-Day Habit History</h3>
				{recentLogs.length === 0 ? (
					<p className="mt-2 text-muted-foreground">Complete a study block or log sleep/habits to start building your streak.</p>
				) : (
					<div className="mt-2.5 flex flex-col gap-2">
						{recentLogs.map((l) => {
							const studyMin = Object.values(l.loggedStudyMinBySubject).reduce((a, b) => a + b, 0);
							return (
								<div key={l.date} className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2">
									<div>
										<div className="font-medium">{l.date}</div>
										<div className="text-[11px] text-muted-foreground">
											{l.actualBedtime ? `Slept ${l.actualBedtime}` : "Bedtime not logged"}
											{l.energyScore ? ` · Energy ${l.energyScore}/5` : ""}
										</div>
									</div>
									<div className="text-right">
										<div className="font-medium tabular-nums">{formatMinCompact(studyMin)}</div>
										<div className="text-[11px] text-muted-foreground">
											{l.hobbyDone ? "Hobby ✓" : "—"} · {l.mealsOk ? "Meals ✓" : "—"}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

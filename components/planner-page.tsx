"use client";

import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import Link from "next/link";
import {
	addDaysToDate,
	buildMonthGridDates,
	clipPreservingLatex,
	computeLocalPlannerPlan,
	daysBetweenDates,
	formatClockMin,
	formatPlainMathPreview,
	normalizeSubjectKey,
	parseClockMin,
	resolveSubjectMaxDailyCap,
	WEEKDAY_LABELS,
	WEEKDAYS,
	type CognitiveLoad,
	type DailyHabitLog,
	type DailyStudyPlan,
	type DayOneOffEvent,
	type DayOverride,
	type FixedEventCategory,
	type FixedWeeklyEvent,
	type JournalActivityCategory,
	type JournalActivityEntry,
	type LifestyleConfig,
	type MilestoneKind,
	type PeakFocusWindow,
	type PersonalizedWorkloadEstimate,
	type PlanComplianceReport,
	type PlannedBlock,
	type PlannerConfig,
	type PlannerEngineMode,
	type PlannerIntensity,
	type PlannerPersonalSignals,
	type StudyMilestone,
	type SyllabusTopic,
	type Weekday,
	type WeeklyForecastDay,
} from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { HostMarkdown } from "@/components/host-markdown";
import { BrailleSpinner } from "@/components/braille-spinner";
import { PlannerCoachChat } from "@/components/planner-coach-chat";
import { PlannerCapacityModal } from "@/components/planner-capacity-modal";
import { useServerEvent } from "@/components/server-events";
import { cn } from "@/lib/utils";
import {
	ArrowUpRightIcon,
	BookOpenIcon,
	BrainIcon,
	CalendarClockIcon,
	CheckCircle2Icon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CircleIcon,
	CpuIcon,
	FileUpIcon,
	FlameIcon,
	HeartPulseIcon,
	ImagePlusIcon,
	Link2Icon,
	MessageSquareTextIcon,
	MoonIcon,
	PauseIcon,
	PencilIcon,
	PinIcon,
	PlusIcon,
	RefreshCwIcon,
	RotateCcwIcon,
	SaveIcon,
	ScaleIcon,
	SearchIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	TrashIcon,
	WandSparklesIcon,
	XIcon,
} from "lucide-react";

interface PlannerSnapshot {
	config: PlannerConfig;
	plan: DailyStudyPlan;
	signals: PlannerPersonalSignals;
	aiAvailability: {
		coach: { available: boolean; modelLabel: string | null };
		vision: { available: boolean; modelLabel: string | null };
		research: { available: boolean; modelLabel: string | null; webSearch: boolean };
		availableRoles?: Array<{ role: string; label: string; modelLabel: string }>;
	};
}

type PlannerTab = "today" | "milestones" | "tkb" | "lifestyle" | "journal";

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

const MONTH_NAMES = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function PlannerMathText({ text, className }: { text: string; className?: string }) {
	const safe = clipPreservingLatex(text, 280);
	const hasBalancedMath = /\$[^$]+\$/.test(safe) && (safe.match(/(?<!\\)\$/g) ?? []).length % 2 === 0;
	if (!hasBalancedMath) {
		return <span className={className}>{formatPlainMathPreview(safe, 260)}</span>;
	}
	return (
		<span className={cn("inline [&_.katex]:[font-size:1em] [&_p]:m-0 [&_p]:inline", className)}>
			<HostMarkdown text={safe} />
		</span>
	);
}

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
	const [coachRole, setCoachRole] = useState("");
	const [coachOpen, setCoachOpen] = useState(false);
	const [coachFocusArea, setCoachFocusArea] = useState<"schedule" | "lifestyle" | "general">("schedule");
	const [coachDraft, setCoachDraft] = useState("");
	const [coachSending, setCoachSending] = useState(false);
	const [capacityOpen, setCapacityOpen] = useState(false);
	const [resetSecondsLeft, setResetSecondsLeft] = useState(0);
	const resetTimerActive = resetSecondsLeft > 0;
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	useEffect(() => {
		if (!resetTimerActive) return;
		const id = window.setInterval(() => {
			setResetSecondsLeft((cur) => (cur <= 1 ? 0 : cur - 1));
		}, 1000);
		return () => window.clearInterval(id);
	}, [resetTimerActive]);

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
				const mode = overrideMode ?? snap?.config.engineMode ?? "local";
				const res = await fetch("/api/planner/generate", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						mode,
						...(mode === "llm" && coachRole ? { preferredRole: coachRole } : {}),
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
		[aiNote, coachRole, snap?.config.engineMode],
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

	const sendToCoach = useCallback(
		async (message: string, area?: "schedule" | "lifestyle" | "general") => {
			const targetArea = area ?? coachFocusArea;
			setCoachOpen(true);
			setCoachFocusArea(targetArea);
			setCoachSending(true);
			setErrorMsg(null);
			try {
				const res = await fetch("/api/planner/coach", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						action: "send",
						message,
						focusArea: targetArea,
						date: snap?.plan.date,
						...(coachRole ? { preferredRole: coachRole } : {}),
					}),
				});
				const body = (await res.json()) as { snapshot?: PlannerSnapshot; error?: string };
				if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
				if (body.snapshot) setSnap(body.snapshot);
			} catch (e) {
				setErrorMsg(e instanceof Error ? e.message : "Coach Chat failed.");
			} finally {
				setCoachSending(false);
			}
		},
		[coachFocusArea, coachRole, snap?.plan.date],
	);

	const undoCoachChange = useCallback(
		async (messageId: string) => {
			setCoachSending(true);
			setErrorMsg(null);
			try {
				const res = await fetch("/api/planner/coach", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action: "undo", messageId, date: snap?.plan.date }),
				});
				const body = (await res.json()) as { snapshot?: PlannerSnapshot; error?: string };
				if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
				if (body.snapshot) setSnap(body.snapshot);
			} catch (e) {
				setErrorMsg(e instanceof Error ? e.message : "Could not undo coach changes.");
			} finally {
				setCoachSending(false);
			}
		},
		[snap?.plan.date],
	);

	const clearCoachChat = useCallback(async () => {
		setCoachSending(true);
		try {
			const res = await fetch("/api/planner/coach", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "clear", date: snap?.plan.date }),
			});
			const body = (await res.json()) as { snapshot?: PlannerSnapshot };
			if (res.ok && body.snapshot) setSnap(body.snapshot);
		} finally {
			setCoachSending(false);
		}
	}, [snap?.plan.date]);

	const openCoachForArea = useCallback((area: "schedule" | "lifestyle" | "general", prefill?: string) => {
		setCoachFocusArea(area);
		setCoachOpen(true);
		if (prefill) setCoachDraft(prefill);
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
									onClick={() => {
										void patchPlanner({ intensity: id }).then(() => {
											if (snap.config.engineMode === "llm" && snap.aiAvailability.coach.available) {
												void generatePlan("llm");
											}
										});
									}}
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
							data-testid="planner-capacity-btn"
							onClick={() => setCapacityOpen(true)}
							title="Cognitive & Learning Capacity Diagnostics (Lực học cá nhân — 0 tokens)"
							className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
						>
							<BrainIcon className="size-3.5 text-primary" /> Lực học
						</button>

						<button
							type="button"
							data-testid="planner-coach-toggle"
							onClick={() => setCoachOpen((v) => !v)}
							title="Open AI Study & Habit Coach Side Chat"
							className={cn(
								"inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
								coachOpen ? "border-primary bg-primary/10 text-primary" : "bg-muted/40 text-foreground hover:bg-accent",
							)}
						>
							<MessageSquareTextIcon className="size-3.5" /> Coach
						</button>

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

			<div className="flex min-h-0 flex-1 overflow-hidden">
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
					<div className={cn("mx-auto flex w-full flex-col gap-4 px-4 py-5 sm:px-6", coachOpen ? "max-w-4xl" : "max-w-5xl")}>
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
									<div className="mt-1.5 flex flex-wrap items-baseline gap-2">
										<span className="text-2xl font-semibold tracking-tight">{snap.plan.minDailyStudyHours}h+</span>
										<span className="text-xs text-muted-foreground">
											planned {snap.plan.plannedStudyHours}h · free {snap.plan.freeHoursTotal}h
										</span>
										{snap.plan.realismApplied !== undefined && snap.plan.realismApplied !== 1 && (
											<span
												className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0 text-[10px] tabular-nums text-primary"
												title="EWMA learned capacity ratio from past journal/habit audits"
											>
												Realism {Math.round(snap.plan.realismApplied * 100)}%
											</span>
										)}
									</div>
									{snap.plan.carryoverNote && (
										<p className="mt-1 text-[11px] text-primary">{snap.plan.carryoverNote}</p>
									)}
									{snap.plan.examDeficitWarning && (
										<p className="mt-1 text-[11px] text-warning">{snap.plan.examDeficitWarning}</p>
									)}
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
									<div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2 text-[11px]">
										<button
											type="button"
											onClick={() => void checkIn({ date: snap.plan.date, foodComaHitToday: !todayLog?.foodComaHitToday })}
											className={cn(
												"rounded-md border px-2 py-0.5 transition-colors",
												todayLog?.foodComaHitToday ? "border-warning/40 bg-warning/10 text-warning" : "text-muted-foreground hover:bg-accent",
											)}
											title="Log post-dinner drowsiness so AI Coach softens 20:00–21:15 load"
										>
											{todayLog?.foodComaHitToday ? "✓ Evening Dip Logged" : "Post-Meal Dip"}
										</button>
										<button
											type="button"
											onClick={() => setResetSecondsLeft((cur) => (cur > 0 ? 0 : 600))}
											data-testid="planner-reset-timer-btn"
											className={cn(
												"rounded-md border px-2 py-0.5 font-medium tabular-nums transition-colors",
												resetSecondsLeft > 0 ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
											)}
											title="Start a quiet 10-minute active reset / urge-surfing timer"
										>
											{resetSecondsLeft > 0
												? `Reset ${Math.floor(resetSecondsLeft / 60)}:${String(resetSecondsLeft % 60).padStart(2, "0")} · Stop`
												: "10m Active Reset"}
										</button>
										<button
											type="button"
											onClick={() => {
												setResetSecondsLeft(0);
												void checkIn({ date: snap.plan.date, incrementUrgesSurfed: true });
											}}
											data-testid="planner-wave-surfed-btn"
											className={cn(
												"rounded-md border px-2 py-0.5 transition-colors",
												(todayLog?.urgesSurfed ?? 0) > 0
													? "border-success/40 bg-success/10 text-success"
													: "text-muted-foreground hover:bg-accent",
											)}
											title="Record riding out an impulse or drowsiness wave without giving in"
										>
											Wave Surfed ✓{(todayLog?.urgesSurfed ?? 0) > 0 ? ` (${todayLog?.urgesSurfed})` : ""}
										</button>
									</div>
									{resetSecondsLeft > 0 && (
										<div className="mt-2 rounded-lg border border-primary/30 bg-primary/5 p-2 text-[11px] leading-relaxed text-foreground">
											<div className="font-medium text-primary">10m Transition &amp; Impulse Reset Active</div>
											<div className="mt-0.5 text-muted-foreground">
												{snap.config.lifestyle.wellnessGuardrail?.wakeUpAnchorProtocol ||
													snap.config.lifestyle.wellnessGuardrail?.replacementProtocol ||
													"Feet on floor, drink cold water, leave bed/screen for 5–10m until prefrontal control resets."}
											</div>
											{snap.config.lifestyle.wellnessGuardrail?.cravingReframeNote && (
												<div className="mt-1 italic text-foreground">
													&ldquo;{snap.config.lifestyle.wellnessGuardrail.cravingReframeNote}&rdquo;
												</div>
											)}
										</div>
									)}
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
									<div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
										<label className="text-[11px] text-muted-foreground">Slept:</label>
										<input
											type="time"
											value={todayLog?.actualBedtime ?? snap.config.lifestyle.sleep.currentBedtime}
											onChange={(e) => void checkIn({ date: snap.plan.date, actualBedtime: e.target.value })}
											className="rounded border bg-background px-1.5 py-0.5 text-xs"
										/>
										<label className="text-[11px] text-muted-foreground">Woke:</label>
										<input
											type="time"
											value={todayLog?.actualWakeTime ?? snap.plan.todayWakeTime}
											onChange={(e) => void checkIn({ date: snap.plan.date, actualWakeTime: e.target.value })}
											className="rounded border bg-background px-1.5 py-0.5 text-xs"
										/>
										<button
											type="button"
											onClick={() => void checkIn({ date: snap.plan.date, wokeEarlyUnintended: !todayLog?.wokeEarlyUnintended })}
											className={cn(
												"rounded border px-1.5 py-0.5 text-[10px] transition-colors",
												todayLog?.wokeEarlyUnintended ? "border-warning/40 bg-warning/10 text-warning" : "text-muted-foreground hover:bg-accent",
											)}
											title="Flag unintended 4-5 AM awakening so schedule softens morning load and adds recovery nap"
										>
											{todayLog?.wokeEarlyUnintended ? "Woke early ✓" : "Woke early?"}
										</button>
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
										<div className="mt-1.5 text-xs leading-relaxed text-foreground">
											<PlannerMathText text={snap.plan.coachSummary} />
										</div>
									) : (
										<div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
											{snap.signals.subjectSignals.length > 0
												? `${snap.signals.subjectSignals.reduce((a, s) => a + s.dueCount, 0)} FSRS cards due · ${snap.signals.subjectSignals.reduce((a, s) => a + s.weakCount, 0)} weak foundations tracked.`
												: "Add exams, competitions, or weekly fixed events to tailor your study quotas."}
											{snap.signals.mistakeHints?.recentRules[0] && (
												<span>
													{" "}Top mistake rule: &ldquo;
													<PlannerMathText text={snap.signals.mistakeHints.recentRules[0]} className="text-foreground" />
													&rdquo;
												</span>
											)}
										</div>
									)}
									{snap.signals.learningProfile && (
										<div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
											<button
												type="button"
												onClick={() => setCapacityOpen(true)}
												className={cn(
													"rounded border px-1.5 py-0.5 text-left transition-colors hover:opacity-80",
													snap.signals.learningProfile.sufficientData
														? "border-success/40 bg-success/10 text-success"
														: "border-border bg-muted/40",
												)}
												title="Click to inspect full scientific Lực học diagnostics (6 axes)"
											>
												{snap.signals.learningProfile.sufficientData
													? `Lực học calibrated · Solve ${snap.signals.learningProfile.overallSolveRatePct ?? "—"}% · FSRS ${snap.signals.learningProfile.overallRetentionPct ?? "—"}% → Inspect`
													: `Lực học (${snap.signals.learningProfile.totalFsrsReviews}/8 FSRS) → Inspect`}
											</button>
											{todayLog?.compliance && (
												<button
													type="button"
													onClick={() => setTab("journal")}
													className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary hover:underline"
												>
													Today audit: {todayLog.compliance.adherencePct}%
												</button>
											)}
										</div>
									)}
									{snap.config.engineMode === "llm" && (
										<div className="mt-2 flex flex-wrap gap-1.5">
											<input
												type="text"
												value={aiNote}
												onChange={(e) => setAiNote(e.target.value)}
												placeholder="Optional AI note (e.g. dậy sớm 4h mệt, ưu tiên đề 1 BTVN)..."
												className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
											/>
											{snap.aiAvailability.availableRoles && snap.aiAvailability.availableRoles.length > 0 && (
												<select
													value={coachRole}
													onChange={(e) => setCoachRole(e.target.value)}
													className="max-w-[155px] truncate rounded-md border bg-background px-1.5 py-1 text-[11px]"
													title="Select AI Coach model role"
												>
													<option value="">Auto ({snap.aiAvailability.coach.modelLabel ?? "coach"})</option>
													{snap.aiAvailability.availableRoles.map((r) => (
														<option key={r.role} value={r.role}>
															{r.label}: {r.modelLabel}
														</option>
													))}
												</select>
											)}
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
										{ id: "journal", label: "24h Journal & Audit" },
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
								<TodayQuotasTab
									snap={snap}
									todayLog={todayLog}
									busy={busy}
									coachBusy={coachSending}
									onCheckIn={checkIn}
									onPatch={patchPlanner}
									onAskCoach={(text) => void sendToCoach(text, "schedule")}
								/>
							)}
							{tab === "milestones" && (
								<MilestonesTab
									snap={snap}
									busy={busy}
									onPatch={patchPlanner}
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
									onOpenCoach={(prefill) => openCoachForArea("lifestyle", prefill)}
									onError={setErrorMsg}
								/>
							)}
							{tab === "journal" && (
								<JournalAuditTab
									snap={snap}
									busy={busy}
									onCheckIn={checkIn}
									onSnapshotUpdate={setSnap}
									onError={setErrorMsg}
								/>
							)}
						</>
					)}
					</div>
				</div>

				{coachOpen && snap && (
					<PlannerCoachChat
						messages={snap.config.coachChat ?? []}
						lastUndoMessageId={snap.config.lastCoachUndo?.messageId}
						focusArea={coachFocusArea}
						onChangeFocusArea={setCoachFocusArea}
						coachAvailable={snap.aiAvailability.coach.available}
						coachModelLabel={snap.aiAvailability.coach.modelLabel}
						availableRoles={snap.aiAvailability.availableRoles}
						selectedRole={coachRole}
						onChangeRole={setCoachRole}
						sending={coachSending}
						draftText={coachDraft}
						onDraftChange={setCoachDraft}
						onSend={sendToCoach}
						onUndo={undoCoachChange}
						onClear={clearCoachChat}
						onClose={() => setCoachOpen(false)}
					/>
				)}
			</div>

			{snap && (
				<PlannerCapacityModal
					open={capacityOpen}
					onClose={() => setCapacityOpen(false)}
					date={snap.plan.date}
					selectedRole={coachRole}
					onChangeRole={setCoachRole}
					onSnapshotUpdated={load}
					onAskCoachWithReport={(prompt) => void sendToCoach(prompt, "general")}
				/>
			)}
		</div>
	);
}

function TodayQuotasTab({
	snap,
	todayLog,
	busy,
	coachBusy,
	onCheckIn,
	onPatch,
	onAskCoach,
}: {
	snap: PlannerSnapshot;
	todayLog: DailyHabitLog | undefined;
	busy: boolean;
	coachBusy: boolean;
	onCheckIn: (payload: Record<string, unknown>) => Promise<void>;
	onPatch: (patch: Partial<PlannerConfig>) => Promise<void>;
	onAskCoach: (text: string) => void;
}) {
	const date = snap.plan.date;
	const todayOverride = snap.config.dayOverrides?.[date];
	const focusSubjects = todayOverride?.focusSubjects ?? [];
	const mutedSubjects = snap.config.mutedSubjects ?? [];
	const pinnedSubjects = snap.config.pinnedSubjects ?? [];
	const dailyMaxCap = resolveSubjectMaxDailyCap(snap.config);

	const [selectedForecastDay, setSelectedForecastDay] = useState<string | null>(null);
	const [showOtherSubjects, setShowOtherSubjects] = useState(false);
	const [customizing, setCustomizing] = useState(false);
	const [coachQuickMsg, setCoachQuickMsg] = useState("");

	// Direct today routine overrides (wake / bed / meals)
	const [wakeDraft, setWakeDraft] = useState(todayOverride?.wakeTime ?? snap.plan.todayWakeTime);
	const [bedDraft, setBedDraft] = useState(todayOverride?.bedTime ?? snap.plan.recommendedBedtime);
	const [mealsDraft, setMealsDraft] = useState(() =>
		(todayOverride?.meals && todayOverride.meals.length > 0 ? todayOverride.meals : snap.config.lifestyle.meals).map((m) => ({ ...m })),
	);

	// New custom block draft
	const [newBlkStart, setNewBlkStart] = useState("19:00");
	const [newBlkEnd, setNewBlkEnd] = useState("20:00");
	const [newBlkType, setNewBlkType] = useState<PlannedBlock["type"]>("study");
	const [newBlkSubject, setNewBlkSubject] = useState(snap.plan.quotas[0]?.subject ?? "");
	const [newBlkTitle, setNewBlkTitle] = useState("");
	const [editingBlkId, setEditingBlkId] = useState<string | null>(null);
	const [blkDraft, setBlkDraft] = useState<PlannedBlock | null>(null);

	useEffect(() => {
		const ov = snap.config.dayOverrides?.[date];
		setWakeDraft(ov?.wakeTime ?? snap.plan.todayWakeTime);
		setBedDraft(ov?.bedTime ?? snap.plan.recommendedBedtime);
		setMealsDraft((ov?.meals && ov.meals.length > 0 ? ov.meals : snap.config.lifestyle.meals).map((m) => ({ ...m })));
	}, [date, snap.config.dayOverrides, snap.config.lifestyle.meals, snap.plan.todayWakeTime, snap.plan.recommendedBedtime]);

	const completedBlocks = new Set(todayLog?.completedBlockIds ?? []);
	const completedChecks = new Set(todayLog?.completedChecklistIds ?? []);
	const loggedBySubj = todayLog?.loggedStudyMinBySubject ?? {};
	const autoPendingEntries = Object.entries(snap.signals.autoTrackedStudyMinBySubject ?? {})
		.map(([subj, autoMin]) => ({ subj, delta: autoMin - (loggedBySubj[subj] ?? 0) }))
		.filter((item) => item.delta >= 5);

	const activeQuotaKeys = new Set(snap.plan.quotas.map((q) => normalizeSubjectKey(q.subject)));
	const allKnownSubjects = useMemo(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const m of snap.config.milestones) {
			const k = normalizeSubjectKey(m.subject);
			if (!seen.has(k)) {
				seen.add(k);
				out.push(m.subject);
			}
		}
		for (const sig of snap.signals.subjectSignals) {
			const k = normalizeSubjectKey(sig.label);
			if (!seen.has(k)) {
				seen.add(k);
				out.push(sig.label);
			}
		}
		return out;
	}, [snap.config.milestones, snap.signals.subjectSignals]);

	const toggleMuteSubject = async (subj: string) => {
		const key = normalizeSubjectKey(subj);
		const exists = mutedSubjects.some((m) => normalizeSubjectKey(m) === key);
		const nextMuted = exists
			? mutedSubjects.filter((m) => normalizeSubjectKey(m) !== key)
			: [...mutedSubjects, subj];
		await onPatch({ mutedSubjects: nextMuted });
	};

	const togglePinSubject = async (subj: string) => {
		const key = normalizeSubjectKey(subj);
		const exists = pinnedSubjects.some((p) => normalizeSubjectKey(p) === key);
		const nextPinned = exists
			? pinnedSubjects.filter((p) => normalizeSubjectKey(p) !== key)
			: [...pinnedSubjects, subj];
		const nextMuted = mutedSubjects.filter((m) => normalizeSubjectKey(m) !== key);
		await onPatch({ pinnedSubjects: nextPinned, mutedSubjects: nextMuted });
	};

	const toggleFocusSubjectToday = async (subj: string | null) => {
		const prevOverrides = snap.config.dayOverrides ?? {};
		const cur = prevOverrides[date] ?? { date };
		let nextFocus: string[] = [];
		if (subj !== null) {
			const key = normalizeSubjectKey(subj);
			const exists = focusSubjects.some((f) => normalizeSubjectKey(f) === key);
			nextFocus = exists ? focusSubjects.filter((f) => normalizeSubjectKey(f) !== key) : [subj];
		}
		const updatedOv: DayOverride = {
			...cur,
			date,
			focusSubjects: nextFocus.length > 0 ? nextFocus : undefined,
			customBlocks: undefined, // Clear custom lock so focus change regenerates timeline
		};
		await onPatch({ dayOverrides: { ...prevOverrides, [date]: updatedOv } });
	};

	const saveTodayRoutineOverride = async () => {
		const prevOverrides = snap.config.dayOverrides ?? {};
		const cur = prevOverrides[date] ?? { date };
		await onPatch({
			dayOverrides: {
				...prevOverrides,
				[date]: {
					...cur,
					date,
					wakeTime: wakeDraft,
					bedTime: bedDraft,
					meals: mealsDraft,
					customBlocks: undefined,
				},
			},
		});
	};

	const saveCustomBlocksList = async (blocks: PlannedBlock[]) => {
		const prevOverrides = snap.config.dayOverrides ?? {};
		const cur = prevOverrides[date] ?? { date };
		await onPatch({
			dayOverrides: {
				...prevOverrides,
				[date]: {
					...cur,
					date,
					customBlocks: blocks.length > 0 ? blocks : undefined,
				},
			},
		});
	};

	const handleSaveEditedBlock = async () => {
		if (!blkDraft) return;
		const sMin = parseClockMin(blkDraft.startTime) ?? blkDraft.startMin;
		let eMin = parseClockMin(blkDraft.endTime) ?? blkDraft.endMin;
		if (eMin <= sMin) eMin += 1440;
		const updated: PlannedBlock = {
			...blkDraft,
			startMin: sMin,
			endMin: eMin,
			startTime: formatClockMin(sMin),
			endTime: formatClockMin(eMin),
			durationMin: Math.max(5, eMin - sMin),
		};
		const nextBlocks = snap.plan.blocks.map((b) => (b.id === updated.id ? updated : b));
		setEditingBlkId(null);
		setBlkDraft(null);
		await saveCustomBlocksList(nextBlocks);
	};

	const handleAddCustomBlock = async () => {
		const sMin = parseClockMin(newBlkStart);
		let eMin = parseClockMin(newBlkEnd);
		if (sMin === null || eMin === null) return;
		if (eMin <= sMin) eMin += 1440;
		const subjTrim = newBlkSubject.trim();
		const titleTrim = newBlkTitle.trim() || (subjTrim || "Custom block");
		const nextBlk: PlannedBlock = {
			id: `blk_custom_${Date.now()}`,
			date,
			startTime: formatClockMin(sMin),
			endTime: formatClockMin(eMin),
			startMin: sMin,
			endMin: eMin,
			durationMin: Math.max(5, eMin - sMin),
			type: newBlkType,
			title: titleTrim,
			...(subjTrim ? { subject: subjTrim } : {}),
			reason: "Custom block",
		};
		setNewBlkTitle("");
		await saveCustomBlocksList([...snap.plan.blocks, nextBlk]);
	};

	const handleDeleteBlock = async (id: string) => {
		await saveCustomBlocksList(snap.plan.blocks.filter((b) => b.id !== id));
	};

	const inspectedForecast: WeeklyForecastDay | undefined = snap.plan.weeklyForecast?.find(
		(d) => d.date === (selectedForecastDay ?? snap.plan.date),
	);

	return (
		<div className="grid gap-4 lg:grid-cols-12">
			{/* Daily Subject Quotas + Checklist */}
			<div className="flex flex-col gap-3 lg:col-span-5">
				{snap.plan.weeklyForecast && snap.plan.weeklyForecast.length > 0 && (
					<div className="rounded-xl border bg-card p-3">
						<div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
							<span>7-Day Workload Forecast (click a day to inspect)</span>
							<span>Free vs Target</span>
						</div>
						<div className="grid grid-cols-7 gap-1 text-center text-[10px]">
							{snap.plan.weeklyForecast.map((day) => {
								const isSelected = inspectedForecast?.date === day.date;
								return (
									<button
										key={day.date}
										type="button"
										onClick={() => setSelectedForecastDay(isSelected && selectedForecastDay ? null : day.date)}
										className={cn(
											"rounded-md border px-1 py-1 transition-colors hover:bg-accent/60",
											day.date === snap.plan.date && "border-primary/60 bg-primary/5",
											day.loadLevel === "heavy" && "border-warning/40 bg-warning/10",
											isSelected && "ring-1 ring-primary",
										)}
										title={day.milestoneTitles.length > 0 ? `Due: ${day.milestoneTitles.join(", ")}` : `${day.freeHours}h free`}
									>
										<div className="font-medium text-muted-foreground">{WEEKDAY_LABELS[day.weekday]}</div>
										<div className="mt-0.5 tabular-nums font-semibold text-foreground">{day.plannedHours}h</div>
									</button>
								);
							})}
						</div>
						{inspectedForecast && (
							<div className="mt-2.5 rounded-lg border bg-muted/25 p-2.5 text-[11px]">
								<div className="flex items-center justify-between gap-2">
									<span className="font-medium text-foreground">
										{WEEKDAY_LABELS[inspectedForecast.weekday]} {inspectedForecast.date} · {inspectedForecast.plannedHours}h study / {inspectedForecast.freeHours}h free
									</span>
									{inspectedForecast.carryoverInMinutes && inspectedForecast.carryoverInMinutes > 0 && (
										<span className="text-primary">+{inspectedForecast.carryoverInMinutes}m carryover</span>
									)}
								</div>
								{inspectedForecast.milestoneTitles.length > 0 && (
									<div className="mt-1 font-medium text-warning">
										Milestone due: {inspectedForecast.milestoneTitles.join(", ")}
									</div>
								)}
								{inspectedForecast.subjects && inspectedForecast.subjects.length > 0 ? (
									<ul className="mt-1.5 space-y-1 text-muted-foreground">
										{inspectedForecast.subjects.map((sub) => (
											<li key={sub.subject} className="flex items-start justify-between gap-2">
												<span className="min-w-0 truncate">
													<span className="font-medium text-foreground">{sub.subject}</span>
													{sub.focusHint ? ` — ${formatPlainMathPreview(sub.focusHint, 70)}` : ""}
												</span>
												<span className="shrink-0 tabular-nums">{formatMinCompact(sub.plannedMinutes)}</span>
											</li>
										))}
									</ul>
								) : (
									<div className="mt-1 text-muted-foreground">Light/open recovery day.</div>
								)}
							</div>
						)}
					</div>
				)}

				{/* Subject Focus / Max-Per-Day / Paused Background Filter */}
				<div className="rounded-xl border bg-card p-3 text-xs">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="font-medium text-foreground">Focus Today & Subject Filter</span>
						<div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
							<label>Max subjects/day:</label>
							<select
								value={dailyMaxCap}
								disabled={busy}
								onChange={(e) => void onPatch({ dailyMaxSubjects: Number(e.target.value) })}
								className="rounded border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
							>
								{[1, 2, 3, 4, 5].map((n) => (
									<option key={n} value={n}>{n}</option>
								))}
							</select>
						</div>
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-1">
						<button
							type="button"
							disabled={busy}
							onClick={() => void toggleFocusSubjectToday(null)}
							className={cn(
								"rounded-md border px-2 py-0.5 text-[11px] transition-colors",
								focusSubjects.length === 0 ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
							)}
						>
							Balanced Rotation
						</button>
						{allKnownSubjects.slice(0, 6).map((subj) => {
							const activeFocus = focusSubjects.some((f) => normalizeSubjectKey(f) === normalizeSubjectKey(subj));
							const isMuted = mutedSubjects.some((m) => normalizeSubjectKey(m) === normalizeSubjectKey(subj));
							return (
								<button
									key={subj}
									type="button"
									disabled={busy}
									onClick={() => void toggleFocusSubjectToday(subj)}
									title={activeFocus ? "Click to clear today's solo focus" : `Focus today mainly on ${subj}`}
									className={cn(
										"max-w-[170px] truncate rounded-md border px-2 py-0.5 text-[11px] transition-colors",
										activeFocus
											? "border-primary bg-primary/15 font-medium text-primary"
											: isMuted
												? "border-dashed text-muted-foreground/60 line-through hover:bg-accent"
												: "text-muted-foreground hover:bg-accent",
									)}
								>
									{subj}
								</button>
							);
						})}
						{allKnownSubjects.length > 0 && (
							<button
								type="button"
								onClick={() => setShowOtherSubjects((v) => !v)}
								className="ml-auto text-[11px] text-primary hover:underline"
							>
								{showOtherSubjects ? "Hide pool" : "Manage muted/background →"}
							</button>
						)}
					</div>
					{showOtherSubjects && (
						<div className="mt-2 rounded-lg border bg-muted/25 p-2 text-[11px]">
							<div className="mb-1 text-muted-foreground">
								Background Graph clusters stay out of daily overload unless pinned or prioritized by an exam:
							</div>
							<div className="flex flex-col gap-1">
								{allKnownSubjects.map((subj) => {
									const isMuted = mutedSubjects.some((m) => normalizeSubjectKey(m) === normalizeSubjectKey(subj));
									const isPinned = pinnedSubjects.some((p) => normalizeSubjectKey(p) === normalizeSubjectKey(subj));
									const inToday = activeQuotaKeys.has(normalizeSubjectKey(subj));
									return (
										<div key={subj} className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 hover:bg-background/60">
											<span className={cn("min-w-0 truncate", isMuted && "text-muted-foreground line-through")}>
												{subj} {inToday ? "• in today" : ""}
											</span>
											<div className="flex shrink-0 items-center gap-1">
												<button
													type="button"
													disabled={busy}
													onClick={() => void togglePinSubject(subj)}
													className={cn(
														"rounded border px-1.5 py-0.5 text-[10px]",
														isPinned ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
													)}
												>
													{isPinned ? "Pinned" : "Pin"}
												</button>
												<button
													type="button"
													disabled={busy}
													onClick={() => void toggleMuteSubject(subj)}
													className={cn(
														"rounded border px-1.5 py-0.5 text-[10px]",
														isMuted ? "border-warning/40 bg-warning/10 text-warning" : "text-muted-foreground hover:bg-accent",
													)}
												>
													{isMuted ? "Unpause" : "Pause"}
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}
				</div>

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
					<span className="text-xs text-muted-foreground">{snap.plan.quotas.length} active today</span>
				</div>
				{snap.plan.quotas.map((q) => {
					const doneMin = loggedBySubj[q.subject] ?? 0;
					const pct = Math.min(100, Math.round((doneMin / Math.max(1, q.targetMin)) * 100));
					const studyTopic = encodeURIComponent(`${q.subject}: ${q.checklist[0]?.text ?? "focused review"}`);
					const isFocused = focusSubjects.some((f) => normalizeSubjectKey(f) === normalizeSubjectKey(q.subject));
					return (
						<div key={q.id} className="rounded-xl border bg-card p-3.5">
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<div className="flex items-center gap-1.5">
										<span className="truncate text-sm font-medium">{q.subject}</span>
										{q.paceMultiplier && q.paceMultiplier !== 1 && (
											<span
												className="rounded border border-primary/30 bg-primary/10 px-1 py-0 text-[10px] tabular-nums text-primary"
												title="Adaptive pace multiplier calibrated from past sessions & FSRS"
											>
												Pace ×{q.paceMultiplier}
											</span>
										)}
									</div>
									{q.weaknessSummary && (
										<div className="mt-0.5 text-[11px] text-muted-foreground">{q.weaknessSummary}</div>
									)}
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<button
										type="button"
										disabled={busy}
										onClick={() => void toggleFocusSubjectToday(q.subject)}
										title={isFocused ? "Clear solo focus" : "Focus today only on this subject"}
										className={cn(
											"rounded-md border p-1 transition-colors",
											isFocused ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent",
										)}
									>
										<PinIcon className="size-3" />
									</button>
									<button
										type="button"
										disabled={busy}
										onClick={() => void toggleMuteSubject(q.subject)}
										title="Pause / hide this subject from future schedules"
										className="rounded-md border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-warning"
									>
										<PauseIcon className="size-3" />
									</button>
									<Link
										href={`/chat/new?topic=${studyTopic}`}
										className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent"
									>
										Study <ArrowUpRightIcon className="size-3" />
									</Link>
								</div>
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
												<PlannerMathText text={item.text} />
											</button>
										</li>
									);
								})}
							</ul>
						</div>
					);
				})}
			</div>

			{/* Chronological Time-blocks + Direct Today Routine/Block Customizer */}
			<div className="flex flex-col gap-2.5 lg:col-span-7">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<h2 className="text-sm font-medium">Today's Time-Blocked Schedule</h2>
						{snap.plan.isCustomEdited && (
							<span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
								Custom Edited
							</span>
						)}
					</div>
					<div className="flex items-center gap-1.5 text-xs">
						{snap.plan.isCustomEdited && (
							<button
								type="button"
								disabled={busy}
								onClick={() => void saveCustomBlocksList([])}
								className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
								title="Revert custom edits back to adaptive auto-schedule"
							>
								<RotateCcwIcon className="size-3" /> Reset Auto
							</button>
						)}
						<button
							type="button"
							onClick={() => setCustomizing((v) => !v)}
							className={cn(
								"inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
								customizing ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
							)}
						>
							<SlidersHorizontalIcon className="size-3" /> {customizing ? "Done Editing" : "Customize Schedule & Routine"}
						</button>
					</div>
				</div>

				{customizing && (
					<div className="flex flex-col gap-3 rounded-xl border bg-card p-3.5 text-xs">
						{/* Interactive AI Coach Adjust Bar */}
						<div className="rounded-lg border border-primary/25 bg-primary/5 p-2.5">
							<div className="mb-1 flex items-center justify-between text-[11px] font-medium text-foreground">
								<span className="inline-flex items-center gap-1">
									<SparklesIcon className="size-3 text-primary" /> Adjust with AI Coach (Conversational)
								</span>
								<span className="text-[10px] text-muted-foreground">Reads Graph · Sessions · Lực học · Sleep Logs</span>
							</div>
							<form
								className="flex flex-wrap gap-1.5"
								onSubmit={(e) => {
									e.preventDefault();
									const trimmed = coachQuickMsg.trim();
									if (!trimmed || coachBusy) return;
									setCoachQuickMsg("");
									onAskCoach(trimmed);
								}}
							>
								<input
									type="text"
									value={coachQuickMsg}
									onChange={(e) => setCoachQuickMsg(e.target.value)}
									placeholder="Hôm nay thế nào? (VD: dậy 4h mệt, bỏ bớt môn X, thêm chợp mắt trưa, tối ngủ 22:30...)"
									className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1 text-xs"
								/>
								<button
									type="submit"
									disabled={coachBusy || !coachQuickMsg.trim() || !snap.aiAvailability.coach.available}
									className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
								>
									{coachBusy ? <BrailleSpinner /> : <MessageSquareTextIcon className="size-3" />} Ask Coach AI
								</button>
							</form>
						</div>

						<div>
							<div className="mb-1.5 flex items-center justify-between">
								<span className="font-medium text-foreground">Today's Wake, Sleep & Meal Times Override</span>
								<button
									type="button"
									disabled={busy}
									onClick={() => void saveTodayRoutineOverride()}
									className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
								>
									<SaveIcon className="size-3" /> Apply Routine & Recompute
								</button>
							</div>
							<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
								<div>
									<label className="mb-0.5 block text-[10px] text-muted-foreground">Wake today</label>
									<input
										type="time"
										value={wakeDraft}
										onChange={(e) => setWakeDraft(e.target.value)}
										className="w-full rounded border bg-background px-2 py-1"
									/>
								</div>
								<div>
									<label className="mb-0.5 block text-[10px] text-muted-foreground">Sleep tonight</label>
									<input
										type="time"
										value={bedDraft}
										onChange={(e) => setBedDraft(e.target.value)}
										className="w-full rounded border bg-background px-2 py-1"
									/>
								</div>
								{mealsDraft.slice(0, 2).map((meal, idx) => (
									<div key={meal.id}>
										<label className="mb-0.5 block truncate text-[10px] text-muted-foreground">{meal.label}</label>
										<input
											type="time"
											value={meal.startTime}
											onChange={(e) =>
												setMealsDraft((prev) =>
													prev.map((m, i) => (i === idx ? { ...m, startTime: e.target.value } : m)),
												)
											}
											className="w-full rounded border bg-background px-2 py-1"
										/>
									</div>
								))}
							</div>
							{mealsDraft.length > 2 && (
								<div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
									{mealsDraft.slice(2).map((meal, idx) => (
										<div key={meal.id}>
											<label className="mb-0.5 block truncate text-[10px] text-muted-foreground">
												{meal.label} ({meal.durationMin}m)
											</label>
											<input
												type="time"
												value={meal.startTime}
												onChange={(e) =>
													setMealsDraft((prev) =>
														prev.map((m, i) => (i === idx + 2 ? { ...m, startTime: e.target.value } : m)),
													)
												}
												className="w-full rounded border bg-background px-2 py-1"
											/>
										</div>
									))}
								</div>
							)}
						</div>

						<div className="border-t pt-2.5">
							<div className="mb-1.5 font-medium text-foreground">+ Add Block to Today's Timeline</div>
							<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-6">
								<input
									type="time"
									value={newBlkStart}
									onChange={(e) => setNewBlkStart(e.target.value)}
									className="rounded border bg-background px-2 py-1"
								/>
								<input
									type="time"
									value={newBlkEnd}
									onChange={(e) => setNewBlkEnd(e.target.value)}
									className="rounded border bg-background px-2 py-1"
								/>
								<select
									value={newBlkType}
									onChange={(e) => setNewBlkType(e.target.value as PlannedBlock["type"])}
									className="rounded border bg-background px-2 py-1"
								>
									<option value="study">Study</option>
									<option value="hobby">Hobby / Rest</option>
									<option value="break">Break</option>
									<option value="meal">Meal</option>
									<option value="fixed">Fixed Busy</option>
								</select>
								<input
									type="text"
									value={newBlkSubject}
									onChange={(e) => setNewBlkSubject(e.target.value)}
									placeholder="Subject..."
									className="rounded border bg-background px-2 py-1"
								/>
								<input
									type="text"
									value={newBlkTitle}
									onChange={(e) => setNewBlkTitle(e.target.value)}
									placeholder="Task title..."
									className="rounded border bg-background px-2 py-1"
								/>
								<button
									type="button"
									disabled={busy}
									onClick={() => void handleAddCustomBlock()}
									className="inline-flex items-center justify-center gap-1 rounded bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
								>
									<PlusIcon className="size-3" /> Add
								</button>
							</div>
						</div>
					</div>
				)}

				<div className="flex flex-col gap-2">
					{snap.plan.blocks.map((blk) => {
						const isDone = completedBlocks.has(blk.id);
						const canToggle = blk.type === "study" || blk.type === "hobby" || blk.type === "sleep";
						const isEditingThis = editingBlkId === blk.id && blkDraft;
						if (isEditingThis) {
							return (
								<div key={blk.id} className="flex flex-col gap-2 rounded-xl border border-primary bg-card p-3 text-xs">
									<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
										<input
											type="time"
											value={blkDraft.startTime}
											onChange={(e) => setBlkDraft({ ...blkDraft, startTime: e.target.value })}
											className="rounded border bg-background px-2 py-1"
										/>
										<input
											type="time"
											value={blkDraft.endTime}
											onChange={(e) => setBlkDraft({ ...blkDraft, endTime: e.target.value })}
											className="rounded border bg-background px-2 py-1"
										/>
										<select
											value={blkDraft.type}
											onChange={(e) => setBlkDraft({ ...blkDraft, type: e.target.value as PlannedBlock["type"] })}
											className="rounded border bg-background px-2 py-1"
										>
											<option value="study">Study</option>
											<option value="hobby">Hobby / Rest</option>
											<option value="break">Break</option>
											<option value="meal">Meal</option>
											<option value="fixed">Fixed</option>
											<option value="sleep">Sleep</option>
										</select>
										<input
											type="text"
											value={blkDraft.subject ?? ""}
											onChange={(e) => setBlkDraft({ ...blkDraft, subject: e.target.value || undefined })}
											placeholder="Subject"
											className="rounded border bg-background px-2 py-1"
										/>
										<input
											type="text"
											value={blkDraft.title}
											onChange={(e) => setBlkDraft({ ...blkDraft, title: e.target.value })}
											placeholder="Title"
											className="rounded border bg-background px-2 py-1"
										/>
									</div>
									<div className="flex justify-end gap-1.5">
										<button
											type="button"
											onClick={() => {
												setEditingBlkId(null);
												setBlkDraft(null);
											}}
											className="rounded border px-2 py-1 text-muted-foreground hover:bg-accent"
										>
											Cancel
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => void handleSaveEditedBlock()}
											className="rounded bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:opacity-90"
										>
											Save Block
										</button>
									</div>
								</div>
							);
						}
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
										<PlannerMathText text={blk.title} />
									</div>
									{(blk.reason || blk.cognitiveLoad) && (
										<div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
											{blk.cognitiveLoad && (
												<span className="rounded border px-1 py-0 text-[10px] uppercase">
													{blk.cognitiveLoad}
												</span>
											)}
											{blk.reason && <PlannerMathText text={blk.reason} />}
										</div>
									)}
								</div>
								<div className="flex shrink-0 items-center gap-1">
									{customizing && (
										<>
											<button
												type="button"
												onClick={() => {
													setEditingBlkId(blk.id);
													setBlkDraft({ ...blk });
												}}
												aria-label={`Edit ${blk.title}`}
												className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
											>
												<PencilIcon className="size-3.5" />
											</button>
											<button
												type="button"
												disabled={busy}
												onClick={() => void handleDeleteBlock(blk.id)}
												aria-label={`Delete ${blk.title}`}
												className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-error"
											>
												<TrashIcon className="size-3.5" />
											</button>
										</>
									)}
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
	onPatch,
	onError,
}: {
	snap: PlannerSnapshot;
	busy: boolean;
	onPatch: (patch: Partial<PlannerConfig>) => Promise<void>;
	onError: (msg: string) => void;
}) {
	const [editingId, setEditingId] = useState<string | null>(null);
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
	const [examProfileId, setExamProfileId] = useState("");
	const [clusterIds, setClusterIds] = useState<string[]>([]);
	const [researching, setResearching] = useState(false);
	const [extractingFile, setExtractingFile] = useState(false);
	const [selectedResearchRole, setSelectedResearchRole] = useState<string>("");
	const [researchTrace, setResearchTrace] = useState<Array<{
		id: string;
		phase: string;
		message: string;
		detail?: string;
		urls?: string[];
	}>>([]);
	const [researchModelUsed, setResearchModelUsed] = useState<string | null>(null);
	const [estimatingWorkload, setEstimatingWorkload] = useState(false);
	const [workloadEstimate, setWorkloadEstimate] = useState<(PersonalizedWorkloadEstimate & { modelLabel?: string }) | null>(null);

	// Interactive Google-Calendar-style Month / Year view & selected day inspector
	const [calView, setCalView] = useState<"month" | "year">("month");
	const [cursorYear, setCursorYear] = useState(() => Number(snap.plan.date.slice(0, 4)));
	const [cursorMonth, setCursorMonth] = useState(() => Number(snap.plan.date.slice(5, 7)) - 1);
	const [selectedDate, setSelectedDate] = useState(snap.plan.date);

	const activeOverride: DayOverride | undefined = snap.config.dayOverrides?.[selectedDate];
	const [ovStart, setOvStart] = useState("08:00");
	const [ovEnd, setOvEnd] = useState("10:00");
	const [ovTitle, setOvTitle] = useState("");
	const [ovCat, setOvCat] = useState<FixedEventCategory>("other");
	const [ovNoteDraft, setOvNoteDraft] = useState("");
	const [ovHoursDraft, setOvHoursDraft] = useState("");

	useEffect(() => {
		const ov = snap.config.dayOverrides?.[selectedDate];
		setOvNoteDraft(ov?.note ?? "");
		setOvHoursDraft(ov?.studyTargetHoursOverride !== undefined ? String(ov.studyTargetHoursOverride) : "");
	}, [selectedDate, snap.config.dayOverrides]);

	const resetMilestoneForm = (targetDate?: string) => {
		setEditingId(null);
		setKind("competition");
		setTitle("");
		setSubject("");
		setDueDate(targetDate ?? selectedDate);
		setPriority(3);
		setLoad("heavy");
		setHours(20);
		setNotes("");
		setTopics([]);
		setSourceSummary("");
		setExamProfileId("");
		setClusterIds([]);
	};

	const loadMilestoneForEdit = (m: StudyMilestone) => {
		setEditingId(m.id);
		setKind(m.kind);
		setTitle(m.title);
		setSubject(m.subject);
		setDueDate(m.dueDate);
		setPriority(m.priority);
		setLoad(m.cognitiveLoad);
		setHours(m.estimatedHours);
		setNotes(m.notes ?? "");
		setTopics(m.syllabusTopics.map((t) => ({ ...t })));
		setSourceSummary(m.sourceSummary ?? "");
		setExamProfileId(m.examProfileId ?? "");
		setClusterIds([...m.clusterIds]);
	};

	const callResearchApi = async (opts: {
		preferLocal?: boolean;
		pullOnly?: boolean;
		overrideClusters?: string[];
		overrideExamProfileId?: string;
		overrideTitle?: string;
	}) => {
		const cids = opts.overrideClusters ?? clusterIds;
		const exId = opts.overrideExamProfileId ?? (examProfileId || undefined);
		const effectiveTitle = (opts.overrideTitle ?? title).trim() || notes.split(/\r?\n/)[0]?.trim() || "";
		if (!effectiveTitle && !opts.pullOnly && !exId && cids.length === 0) {
			return onError("Enter an exam/competition title, paste syllabus notes, or link a Graph cluster/Exam profile first.");
		}
		const useStream = !opts.pullOnly && !opts.preferLocal;
		setResearching(true);
		if (useStream) {
			setResearchTrace([]);
			setResearchModelUsed(null);
		}
		try {
			const res = await fetch("/api/planner/research-exam", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: effectiveTitle,
					kind,
					dueDate,
					materialsText: notes,
					clusterIds: cids,
					examProfileId: exId,
					pullOnly: Boolean(opts.pullOnly),
					preferLocal: Boolean(opts.preferLocal),
					...(selectedResearchRole ? { preferredRole: selectedResearchRole } : {}),
					stream: useStream,
				}),
			});
			type ResearchPayload = {
				error?: string;
				subject?: string;
				cognitiveLoad?: CognitiveLoad;
				priority?: 1 | 2 | 3;
				estimatedHours?: number;
				syllabusTopics?: SyllabusTopic[];
				sourceSummary?: string;
				pulledContext?: string;
				modelLabel?: string;
				trace?: Array<{ id: string; phase: string; message: string; detail?: string; urls?: string[] }>;
			};
			let body: ResearchPayload | null = null;
			const contentType = res.headers.get("content-type") ?? "";
			if (contentType.includes("application/x-ndjson") && res.body) {
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let nlIdx = buf.indexOf("\n");
					while (nlIdx >= 0) {
						const line = buf.slice(0, nlIdx).trim();
						buf = buf.slice(nlIdx + 1);
						if (line) {
							try {
								const ev = JSON.parse(line) as { type: string; step?: { id: string; phase: string; message: string; detail?: string; urls?: string[] }; data?: ResearchPayload; error?: string };
								if (ev.type === "step" && ev.step) {
									setResearchTrace((prev) => [...prev, ev.step!]);
								} else if (ev.type === "result" && ev.data) {
									body = ev.data;
								} else if (ev.type === "error") {
									throw new Error(ev.error || "Research failed");
								}
							} catch (parseErr) {
								if (parseErr instanceof Error && !parseErr.message.includes("JSON")) throw parseErr;
							}
						}
						nlIdx = buf.indexOf("\n");
					}
				}
			} else {
				body = (await res.json()) as ResearchPayload;
				if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
			}
			if (!body) throw new Error("Empty research response.");
			if (body.modelLabel) setResearchModelUsed(body.modelLabel);
			if (body.trace && body.trace.length > 0) {
				const traceRows = body.trace;
				setResearchTrace((prev) => (prev.length > 0 ? prev : traceRows));
			}
			if (body.subject && !subject.trim()) setSubject(body.subject);
			else if (!opts.pullOnly && body.subject) setSubject(body.subject);
			if (body.cognitiveLoad && !opts.pullOnly) setLoad(body.cognitiveLoad);
			if (body.priority && !opts.pullOnly) setPriority(body.priority);
			if (body.estimatedHours && body.syllabusTopics && body.syllabusTopics.length > 0) {
				setHours(body.estimatedHours);
				setTopics(body.syllabusTopics);
			}
			if (body.sourceSummary) setSourceSummary(body.sourceSummary);
			if (opts.pullOnly && body.pulledContext?.trim() && !notes.includes("[Session/Cluster:")) {
				setNotes((prev) =>
					prev.trim()
						? `${prev.trim()}\n\n${body.pulledContext!.trim()}`
						: body.pulledContext!.trim(),
				);
			}
		} catch (e) {
			onError(e instanceof Error ? e.message : "Syllabus research failed.");
		} finally {
			setResearching(false);
		}
	};

	const callEstimateWorkload = async (useAi: boolean) => {
		const effectiveTitle = title.trim() || subject.trim();
		if (!effectiveTitle) {
			return onError("Enter a title or subject before estimating workload.");
		}
		setEstimatingWorkload(true);
		try {
			const res = await fetch("/api/planner/estimate-workload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: effectiveTitle,
					subject: subject.trim() || effectiveTitle,
					kind,
					dueDate,
					baseHours: hours > 0 ? hours : undefined,
					syllabusTopics: topics,
					clusterIds,
					useAi,
					...(selectedResearchRole ? { preferredRole: selectedResearchRole } : {}),
				}),
			});
			const data = (await res.json()) as PersonalizedWorkloadEstimate & { modelLabel?: string; error?: string };
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			setWorkloadEstimate(data);
			setHours(data.estimatedHours);
			if (data.topicEstimates && data.topicEstimates.length > 0) setTopics(data.topicEstimates);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to estimate personalized workload.");
		} finally {
			setEstimatingWorkload(false);
		}
	};

	const onSelectExamProfile = (id: string) => {
		setExamProfileId(id);
		if (!id) return;
		const prof = snap.signals.examPrep.config.exams.find((x) => x.id === id);
		if (!prof) return;
		const scopeLabels = snap.signals.examPrep.availableScopes
			.filter((s) => prof.clusterIds.includes(s.id))
			.map((s) => s.label);
		if (!title.trim() || !editingId) setTitle(prof.title);
		if (!subject.trim() && scopeLabels[0]) setSubject(scopeLabels[0]);
		if (prof.date) setDueDate(prof.date);
		setClusterIds([...prof.clusterIds]);
		if (prof.clusterIds.length > 0) {
			void callResearchApi({
				pullOnly: true,
				overrideClusters: prof.clusterIds,
				overrideExamProfileId: prof.id,
				overrideTitle: prof.title,
			});
		}
	};

	const onPickMaterialFile = async (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setExtractingFile(true);
		try {
			const form = new FormData();
			form.append("file", file);
			const res = await fetch("/api/planner/extract-material", { method: "POST", body: form });
			const body = (await res.json()) as { error?: string; text?: string; notice?: string };
			if (!res.ok || !body.text) throw new Error(body.error || `Could not extract ${file.name}`);

			if (file.name.toLowerCase().endsWith(".ics")) {
				const sumMatch = /^SUMMARY(?:;[^:]*)?:(.+)$/im.exec(body.text);
				const dtMatch = /^DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})/im.exec(body.text);
				if (sumMatch && !title.trim()) setTitle(sumMatch[1]!.trim().slice(0, 100));
				if (dtMatch) setDueDate(`${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}`);
			}
			const header = `[File: ${file.name}${body.notice ? ` — ${body.notice}` : ""}]`;
			setNotes((prev) => (prev.trim() ? `${prev.trim()}\n\n${header}\n${body.text}` : `${header}\n${body.text}`));
		} catch (err) {
			onError(err instanceof Error ? err.message : "Failed to extract material file.");
		} finally {
			setExtractingFile(false);
		}
	};

	const saveMilestoneForm = async () => {
		if (!title.trim()) return;
		const existing = editingId ? snap.config.milestones.find((m) => m.id === editingId) : undefined;
		const record: StudyMilestone = {
			id: existing?.id ?? (examProfileId ? `ep_${examProfileId}` : `ms_${Date.now()}`),
			kind,
			title: title.trim(),
			subject: subject.trim() || title.trim(),
			dueDate,
			priority,
			cognitiveLoad: load,
			clusterIds: [...clusterIds],
			estimatedHours: Number(hours) || 10,
			completedHours: existing?.completedHours ?? 0,
			syllabusTopics: topics,
			notes: notes.trim(),
			...(sourceSummary ? { sourceSummary } : {}),
			...(examProfileId ? { examProfileId } : {}),
		};
		const nextList = existing
			? snap.config.milestones.map((m) => (m.id === existing.id ? record : m))
			: [...snap.config.milestones.filter((m) => !examProfileId || m.examProfileId !== examProfileId), record];
		await onPatch({ milestones: nextList });
		resetMilestoneForm(dueDate);
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
		await onPatch({ milestones: next });
	};

	const saveDayOverride = async (dateStr: string, patch: Partial<DayOverride> | null) => {
		const currentMap = { ...(snap.config.dayOverrides ?? {}) };
		if (patch === null) {
			delete currentMap[dateStr];
		} else {
			const merged: DayOverride = {
				...(currentMap[dateStr] ?? { date: dateStr }),
				...patch,
				date: dateStr,
			};
			if (
				!merged.skipFixedEvents &&
				(!merged.extraBusyEvents || merged.extraBusyEvents.length === 0) &&
				!merged.note?.trim() &&
				merged.studyTargetHoursOverride === undefined
			) {
				delete currentMap[dateStr];
			} else {
				currentMap[dateStr] = merged;
			}
		}
		await onPatch({ dayOverrides: currentMap });
	};

	const addDayEvent = async () => {
		if (!ovTitle.trim()) return;
		const nextEvent: DayOneOffEvent = {
			id: `ev_${Date.now()}`,
			startTime: ovStart,
			endTime: ovEnd,
			title: ovTitle.trim(),
			category: ovCat,
		};
		const existing = activeOverride?.extraBusyEvents ?? [];
		await saveDayOverride(selectedDate, { extraBusyEvents: [...existing, nextEvent] });
		setOvTitle("");
	};

	const sorted = useMemo(
		() => [...snap.config.milestones].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
		[snap.config.milestones],
	);

	const milestonesByDate = useMemo(() => {
		const map = new Map<string, StudyMilestone[]>();
		for (const m of sorted) {
			const list = map.get(m.dueDate) ?? [];
			list.push(m);
			map.set(m.dueDate, list);
		}
		return map;
	}, [sorted]);

	const monthCells = useMemo(() => buildMonthGridDates(cursorYear, cursorMonth), [cursorYear, cursorMonth]);
	const fixedWeekdaysWithClasses = useMemo(
		() => new Set(snap.config.fixedEvents.map((e) => e.dayOfWeek)),
		[snap.config.fixedEvents],
	);

	const selectedDayMilestones = milestonesByDate.get(selectedDate) ?? [];
	const selectedDayPreview = useMemo(
		() =>
			computeLocalPlannerPlan(snap.config, {
				...snap.signals,
				date: selectedDate,
			}),
		[snap.config, snap.signals, selectedDate],
	);

	const selectDate = (dateStr: string) => {
		setSelectedDate(dateStr);
		if (!editingId) setDueDate(dateStr);
		setCursorYear(Number(dateStr.slice(0, 4)));
		setCursorMonth(Number(dateStr.slice(5, 7)) - 1);
	};

	const goPrev = () => {
		if (calView === "year") {
			setCursorYear((y) => y - 1);
		} else if (cursorMonth === 0) {
			setCursorYear((y) => y - 1);
			setCursorMonth(11);
		} else {
			setCursorMonth((m) => m - 1);
		}
	};

	const goNext = () => {
		if (calView === "year") {
			setCursorYear((y) => y + 1);
		} else if (cursorMonth === 11) {
			setCursorYear((y) => y + 1);
			setCursorMonth(0);
		} else {
			setCursorMonth((m) => m + 1);
		}
	};

	return (
		<div className="grid gap-4 lg:grid-cols-12">
			<div className="flex flex-col gap-3 lg:col-span-7">
				{/* Interactive Google-Calendar-style Month & Year Calendar */}
				<div className="rounded-xl border bg-card p-3.5">
					<div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={goPrev}
								aria-label="Previous calendar period"
								className="rounded-md border p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<ChevronLeftIcon className="size-3.5" />
							</button>
							<span className="min-w-28 text-center text-sm font-medium">
								{calView === "month" ? `${MONTH_NAMES[cursorMonth]} ${cursorYear}` : `${cursorYear}`}
							</span>
							<button
								type="button"
								onClick={goNext}
								aria-label="Next calendar period"
								className="rounded-md border p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<ChevronRightIcon className="size-3.5" />
							</button>
							<button
								type="button"
								onClick={() => selectDate(snap.plan.date)}
								className="ml-1 rounded-md border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								Today
							</button>
						</div>
						<div className="inline-flex rounded-md border bg-muted/40 p-0.5 text-[11px]">
							<button
								type="button"
								onClick={() => setCalView("month")}
								className={cn("rounded px-2 py-0.5", calView === "month" ? "bg-card font-medium shadow-xs" : "text-muted-foreground")}
							>
								Month
							</button>
							<button
								type="button"
								onClick={() => setCalView("year")}
								className={cn("rounded px-2 py-0.5", calView === "year" ? "bg-card font-medium shadow-xs" : "text-muted-foreground")}
							>
								Year
							</button>
						</div>
					</div>

					{calView === "month" ? (
						<div>
							<div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
								{WEEKDAYS.map((w) => (
									<div key={w}>{WEEKDAY_LABELS[w]}</div>
								))}
							</div>
							<div className="grid grid-cols-7 gap-1 text-[11px]">
								{monthCells.map((cell, idx) => {
									const items = milestonesByDate.get(cell.date) ?? [];
									const ov = snap.config.dayOverrides?.[cell.date];
									const weekday = WEEKDAYS[idx % 7]!;
									const hasClass = !ov?.skipFixedEvents && fixedWeekdaysWithClasses.has(weekday);
									const isToday = cell.date === snap.plan.date;
									const isSelected = cell.date === selectedDate;
									return (
										<button
											key={cell.date}
											type="button"
											onClick={() => selectDate(cell.date)}
											className={cn(
												"flex min-h-14 flex-col items-stretch justify-between rounded-md border p-1 text-left transition-colors hover:bg-accent/50",
												!cell.inMonth && "opacity-45",
												isToday && "border-primary/70 bg-primary/5",
												items.length > 0 && "border-warning/60 bg-warning/5",
												isSelected && "ring-2 ring-primary",
											)}
											title={[...items.map((x) => `${x.title} (${x.kind})`), ov?.note].filter(Boolean).join(" · ") || cell.date}
										>
											<div className="flex items-center justify-between gap-1">
												<span className={cn("tabular-nums text-[10px]", isToday ? "font-bold text-primary" : "text-muted-foreground")}>
													{cell.dayNum}
												</span>
												<span className="flex items-center gap-0.5">
													{ov && <span className="size-1.5 rounded-full bg-primary" title="Custom day override" />}
													{hasClass && <span className="size-1 rounded-full bg-muted-foreground/50" title="Weekly TKB" />}
												</span>
											</div>
											<div className="mt-0.5 flex flex-col gap-0.5">
												{items.slice(0, 2).map((it) => (
													<span
														key={it.id}
														className={cn("w-full truncate rounded border px-1 text-[9px] font-medium", KIND_BADGE[it.kind])}
													>
														{it.title}
													</span>
												))}
												{items.length > 2 && (
													<span className="text-[9px] text-muted-foreground">+{items.length - 2} more</span>
												)}
											</div>
										</button>
									);
								})}
							</div>
						</div>
					) : (
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{MONTH_NAMES.map((mName, mIdx) => {
								const miniCells = buildMonthGridDates(cursorYear, mIdx);
								return (
									<div key={mName} className="rounded-lg border bg-background/50 p-2">
										<button
											type="button"
											onClick={() => {
												setCursorMonth(mIdx);
												setCalView("month");
											}}
											className="mb-1.5 text-xs font-semibold hover:text-primary hover:underline"
										>
											{mName} {cursorYear}
										</button>
										<div className="grid grid-cols-7 gap-0.5 text-center text-[9px]">
											{miniCells.map((cell) => {
												if (!cell.inMonth) return <span key={cell.date} className="h-4" />;
												const items = milestonesByDate.get(cell.date) ?? [];
												const ov = snap.config.dayOverrides?.[cell.date];
												const isToday = cell.date === snap.plan.date;
												const isSelected = cell.date === selectedDate;
												return (
													<button
														key={cell.date}
														type="button"
														onClick={() => {
															selectDate(cell.date);
														}}
														title={items.map((x) => `${x.title} (${x.kind})`).join(", ") || cell.date}
														className={cn(
															"flex h-5 items-center justify-center rounded tabular-nums transition-colors hover:bg-accent",
															items.length > 0 && "bg-warning/25 font-semibold text-foreground",
															ov && items.length === 0 && "bg-primary/15 font-medium text-primary",
															isToday && "border border-primary",
															isSelected && "ring-1 ring-primary bg-primary text-primary-foreground",
														)}
													>
														{cell.dayNum}
													</button>
												);
											})}
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* Selected Day Inspector & Day Editor */}
				<div className="rounded-xl border bg-card p-3.5 text-xs" data-testid="planner-selected-day">
					<div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
						<div>
							<span className="text-sm font-medium">{selectedDate}</span>
							<span className="ml-2 text-[11px] text-muted-foreground">
								Preview: {selectedDayPreview.plannedStudyHours}h study · {selectedDayPreview.freeHoursTotal}h free · {selectedDayPreview.blocks.filter((b) => b.type === "fixed").length} fixed
							</span>
						</div>
						<button
							type="button"
							onClick={() => resetMilestoneForm(selectedDate)}
							className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-accent"
						>
							<PlusIcon className="size-3" /> Add milestone on {selectedDate}
						</button>
					</div>

					{selectedDayMilestones.length > 0 && (
						<div className="mt-2.5 flex flex-col gap-1.5">
							{selectedDayMilestones.map((m) => (
								<div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-2.5 py-1.5">
									<div className="min-w-0">
										<span className={cn("mr-1.5 rounded border px-1 py-0 text-[9px] uppercase", KIND_BADGE[m.kind])}>{m.kind}</span>
										<span className="font-medium">{m.title}</span>
										<span className="ml-1.5 text-[11px] text-muted-foreground">({m.completedHours}/{m.estimatedHours}h)</span>
									</div>
									<button
										type="button"
										onClick={() => loadMilestoneForEdit(m)}
										className="shrink-0 rounded border px-2 py-0.5 text-[11px] hover:bg-accent"
									>
										Edit
									</button>
								</div>
							))}
						</div>
					)}

					<div className="mt-3 grid gap-2.5 sm:grid-cols-2">
						<label className="flex items-center gap-2 text-xs text-foreground">
							<input
								type="checkbox"
								checked={Boolean(activeOverride?.skipFixedEvents)}
								onChange={(e) => void saveDayOverride(selectedDate, { skipFixedEvents: e.target.checked })}
							/>
							Skip recurring weekly TKB on this date
						</label>
						<div className="flex items-center gap-2">
							<label className="text-[11px] text-muted-foreground">Study target (h):</label>
							<input
								type="number"
								min={0}
								max={14}
								step={0.5}
								placeholder="Auto"
								value={ovHoursDraft}
								onChange={(e) => setOvHoursDraft(e.target.value)}
								className="w-20 rounded border bg-background px-2 py-0.5 text-xs"
							/>
							<button
								type="button"
								disabled={busy}
								onClick={() =>
									void saveDayOverride(selectedDate, {
										studyTargetHoursOverride: ovHoursDraft.trim() === "" ? undefined : Number(ovHoursDraft),
										note: ovNoteDraft,
									})
								}
								className="rounded border px-2 py-0.5 text-[11px] hover:bg-accent"
							>
								Save Day
							</button>
						</div>
					</div>
					<div className="mt-2">
						<input
							type="text"
							value={ovNoteDraft}
							onChange={(e) => setOvNoteDraft(e.target.value)}
							placeholder="Day note (e.g. Exam day, travel, mock test...)"
							className="w-full rounded-md border bg-background px-2.5 py-1 text-xs"
						/>
					</div>

					{/* One-off busy events just for selectedDate */}
					{(activeOverride?.extraBusyEvents?.length ?? 0) > 0 && (
						<div className="mt-2 flex flex-wrap gap-1.5">
							{activeOverride!.extraBusyEvents!.map((ev) => (
								<span key={ev.id} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px]">
									<span className="tabular-nums text-muted-foreground">{ev.startTime}–{ev.endTime}</span>
									<span className="font-medium">{ev.title}</span>
									<button
										type="button"
										onClick={() =>
											void saveDayOverride(selectedDate, {
												extraBusyEvents: activeOverride!.extraBusyEvents!.filter((x) => x.id !== ev.id),
											})
										}
										className="text-muted-foreground hover:text-destructive"
									>
										×
									</button>
								</span>
							))}
						</div>
					)}
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						<input type="time" value={ovStart} onChange={(e) => setOvStart(e.target.value)} className="rounded border bg-background px-1.5 py-1 text-[11px]" />
						<span>–</span>
						<input type="time" value={ovEnd} onChange={(e) => setOvEnd(e.target.value)} className="rounded border bg-background px-1.5 py-1 text-[11px]" />
						<select value={ovCat} onChange={(e) => setOvCat(e.target.value as FixedEventCategory)} className="rounded border bg-background px-1.5 py-1 text-[11px]">
							<option value="other">Exam / Event</option>
							<option value="class">Extra Class</option>
							<option value="club">Contest / Club</option>
							<option value="commute">Travel</option>
						</select>
						<input
							type="text"
							value={ovTitle}
							onChange={(e) => setOvTitle(e.target.value)}
							placeholder="One-off event on this date..."
							className="min-w-32 flex-1 rounded border bg-background px-2 py-1 text-[11px]"
						/>
						<button
							type="button"
							disabled={busy || !ovTitle.trim()}
							onClick={() => void addDayEvent()}
							className="rounded border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-40"
						>
							+ Event
						</button>
					</div>
				</div>

				{/* Milestone list */}
				<div className="flex items-center justify-between">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
						All Milestones & Synced Exam Profiles ({sorted.length})
					</h3>
					{snap.signals.examPrep.config.exams.length > 0 && (
						<button
							type="button"
							disabled={busy}
							onClick={() => void onPatch({ dismissedExamProfileIds: [] })}
							className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
						>
							<RefreshCwIcon className="size-3" /> Sync Exam Profiles
						</button>
					)}
				</div>

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
											{m.examProfileId && (
												<span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
													Exam Prep
												</span>
											)}
											<span className="text-sm font-medium">{m.title}</span>
											<span className="text-xs text-muted-foreground">
												({dLeft >= 0 ? `D-${dLeft}` : `Overdue ${Math.abs(dLeft)}d`})
											</span>
										</div>
										<div className="mt-1 text-xs text-muted-foreground">
											Subject: {m.subject} · Due {m.dueDate} · {m.completedHours}/{m.estimatedHours}h ({pct}%) · {m.cognitiveLoad}
											{m.clusterIds.length > 0 ? ` · ${m.clusterIds.length} linked cluster${m.clusterIds.length === 1 ? "" : "s"}` : ""}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<button
											type="button"
											disabled={busy}
											onClick={() => loadMilestoneForEdit(m)}
											className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
											title="Edit milestone"
										>
											<PencilIcon className="size-3.5" />
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => void onPatch({ milestones: snap.config.milestones.filter((x) => x.id !== m.id) })}
											className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
											title="Remove milestone"
										>
											<TrashIcon className="size-3.5" />
										</button>
									</div>
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

			{/* Add / Edit & Research Form */}
			<div className="rounded-xl border bg-card p-4 lg:col-span-5">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-medium">{editingId ? "Edit Milestone" : "Add Exam / Competition / Project"}</h3>
					{editingId && (
						<button type="button" onClick={() => resetMilestoneForm()} className="text-xs text-muted-foreground hover:underline">
							Cancel edit
						</button>
					)}
				</div>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Link an existing Exam Profile / Graph sessions to pull materials automatically, or add extra PDF/notes.
				</p>

				<div className="mt-3 flex flex-col gap-2.5 text-xs">
					{snap.signals.examPrep.config.exams.length > 0 && (
						<div>
							<label className="mb-1 flex items-center gap-1 text-muted-foreground">
								<Link2Icon className="size-3" /> Link Exam Prep Profile (auto-sync)
							</label>
							<select
								value={examProfileId}
								onChange={(e) => onSelectExamProfile(e.target.value)}
								className="w-full rounded-md border bg-background px-2 py-1.5"
							>
								<option value="">None (manual milestone)</option>
								{snap.signals.examPrep.config.exams.map((ex) => (
									<option key={ex.id} value={ex.id}>
										{ex.title} {ex.date ? `(${ex.date})` : ""}
									</option>
								))}
							</select>
						</div>
					)}

					{snap.signals.examPrep.availableScopes.length > 0 && (
						<div>
							<div className="mb-1 flex items-center justify-between text-muted-foreground">
								<span>Link Graph Clusters / Sessions ({clusterIds.length})</span>
								{clusterIds.length > 0 && (
									<button
										type="button"
										disabled={researching}
										onClick={() => void callResearchApi({ pullOnly: true })}
										className="text-[11px] font-medium text-primary hover:underline disabled:opacity-40"
									>
										Pull Context (0 tokens)
									</button>
								)}
							</div>
							<div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded-md border bg-background/50 p-1.5">
								{snap.signals.examPrep.availableScopes.map((sc) => {
									const active = clusterIds.includes(sc.id);
									return (
										<button
											key={sc.id}
											type="button"
											onClick={() =>
												setClusterIds((prev) =>
													prev.includes(sc.id) ? prev.filter((x) => x !== sc.id) : [...prev, sc.id],
												)
											}
											className={cn(
												"rounded border px-2 py-0.5 text-[11px] transition-colors",
												active ? "border-primary bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-accent",
											)}
										>
											{sc.label} ({sc.nodeCount})
										</button>
									);
								})}
							</div>
						</div>
					)}

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
							<div className="mb-1 flex items-center justify-between gap-1">
								<label className="text-muted-foreground">Est. Workload (hours)</label>
								<span className="flex items-center gap-1 text-[10px]">
									<button
										type="button"
										disabled={estimatingWorkload || (!title.trim() && !subject.trim())}
										onClick={() => void callEstimateWorkload(false)}
										className="text-primary hover:underline disabled:opacity-40"
										title="Calculate from FSRS stability, Practice speed & Graph gaps (0 tokens)"
									>
										{estimatingWorkload ? "..." : "Calibrate (Lực học · 0t)"}
									</button>
									{snap.aiAvailability.coach.available && (
										<button
											type="button"
											disabled={estimatingWorkload || (!title.trim() && !subject.trim())}
											onClick={() => void callEstimateWorkload(true)}
											className="text-muted-foreground hover:text-primary hover:underline disabled:opacity-40"
										>
											· AI
										</button>
									)}
								</span>
							</div>
							<input
								type="number"
								min={1}
								max={500}
								step={0.5}
								value={hours}
								onChange={(e) => setHours(Number(e.target.value) || 1)}
								className="w-full rounded-md border bg-background px-2.5 py-1.5"
							/>
						</div>
					</div>
					{workloadEstimate && (
						<div className="rounded-lg border bg-muted/30 p-2 text-[11px]">
							<div className="flex items-center justify-between gap-2 font-medium text-foreground">
								<span>
									{workloadEstimate.confidence === "personalized"
										? `Personalized Pace ×${workloadEstimate.paceFactorApplied}`
										: "Baseline Estimate (Insufficient history)"}
								</span>
								<span className="tabular-nums text-primary">~{workloadEstimate.recommendedDailyHours}h/day needed</span>
							</div>
							<ul className="mt-1 space-y-0.5 text-muted-foreground">
								{workloadEstimate.breakdownReasons.map((r, i) => (
									<li key={i}>• {r}</li>
								))}
							</ul>
						</div>
					)}
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
						<div className="mb-1 flex flex-wrap items-center justify-between gap-1">
							<label className="text-muted-foreground">Materials / Syllabus Notes</label>
							<label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-primary hover:underline">
								{extractingFile ? <BrailleSpinner /> : <FileUpIcon className="size-3" />}
								<span>{extractingFile ? "Extracting..." : "Upload .pdf / .epub / .md / .txt"}</span>
								<input type="file" accept=".pdf,.epub,.md,.txt,.tex,.ics" onChange={(e) => void onPickMaterialFile(e)} className="hidden" />
							</label>
						</div>
						<textarea
							rows={3}
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							placeholder="Paste đề cương, giáo trình hoặc kéo context từ session..."
							className="w-full rounded-md border bg-background px-2.5 py-1.5"
						/>
					</div>
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/25 px-2.5 py-1.5 text-[11px]">
						<div className="flex min-w-0 items-center gap-1.5">
							<span className="shrink-0 text-muted-foreground">Model:</span>
							{snap.aiAvailability.availableRoles && snap.aiAvailability.availableRoles.length > 0 ? (
								<select
									value={selectedResearchRole}
									onChange={(e) => setSelectedResearchRole(e.target.value)}
									className="max-w-[200px] truncate rounded border bg-background px-1.5 py-0.5 text-[11px]"
								>
									<option value="">
										Auto ({snap.aiAvailability.research.modelLabel ?? "not set"})
									</option>
									{snap.aiAvailability.availableRoles.map((r) => (
										<option key={r.role} value={r.role}>
											{r.label}: {r.modelLabel}
										</option>
									))}
								</select>
							) : (
								<span className="truncate text-muted-foreground">
									{snap.aiAvailability.research.modelLabel ?? "No AI key configured"}
								</span>
							)}
						</div>
						<span
							className={cn(
								"shrink-0 rounded border px-1.5 py-0 text-[10px]",
								snap.aiAvailability.research.webSearch
									? "border-success/40 bg-success/10 text-success"
									: "border-border text-muted-foreground",
							)}
						>
							Web Search: {snap.aiAvailability.research.webSearch ? "ON" : "OFF (Local/Context)"}
						</span>
					</div>
					<div className="grid grid-cols-2 gap-2 pt-1">
						<button
							type="button"
							disabled={researching || (!notes.trim() && clusterIds.length === 0 && !examProfileId)}
							onClick={() => void callResearchApi({ preferLocal: true })}
							className="inline-flex items-center justify-center gap-1 rounded-md border px-2.5 py-1.5 font-medium hover:bg-accent disabled:opacity-40"
						>
							Parse Outline (0 tokens)
						</button>
						<button
							type="button"
							disabled={researching || (!title.trim() && !examProfileId && clusterIds.length === 0)}
							onClick={() => void callResearchApi({ preferLocal: false })}
							className="inline-flex items-center justify-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1.5 font-medium hover:bg-accent disabled:opacity-40"
						>
							{researching ? <BrailleSpinner /> : <WandSparklesIcon className="size-3.5 text-primary" />}
							Auto-Research (AI)
						</button>
					</div>
					{(researching || researchTrace.length > 0) && (
						<div className="rounded-lg border bg-muted/30 p-2 text-[11px]">
							<div className="mb-1 flex items-center justify-between font-medium text-foreground">
								<span className="inline-flex items-center gap-1">
									<SearchIcon className="size-3 text-primary" /> Research Trace
								</span>
								{researchModelUsed && (
									<span className="truncate text-[10px] text-muted-foreground">{researchModelUsed}</span>
								)}
							</div>
							<ul className="max-h-36 space-y-1 overflow-y-auto text-muted-foreground">
								{researchTrace.map((st) => (
									<li key={st.id} className="leading-snug">
										<span className="font-medium uppercase text-[10px] text-primary">[{st.phase}]</span>{" "}
										<span className="text-foreground">{st.message}</span>
										{st.detail && <div className="pl-2 text-[10px] text-muted-foreground">{st.detail}</div>}
									</li>
								))}
								{researching && (
									<li className="inline-flex items-center gap-1.5 text-primary">
										<BrailleSpinner /> Probing & synthesizing...
									</li>
								)}
							</ul>
						</div>
					)}
					<button
						type="button"
						disabled={busy || !title.trim()}
						onClick={() => void saveMilestoneForm()}
						className="inline-flex w-full items-center justify-center gap-1 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
					>
						<PlusIcon className="size-3.5" /> {editingId ? "Save Milestone Changes" : "Add Milestone"}
					</button>
					{topics.length > 0 && (
						<div className="mt-1 rounded-lg border bg-muted/30 p-2">
							<div className="mb-1 text-[11px] font-medium">Preview Syllabus Topics ({topics.length}):</div>
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
	const [editingId, setEditingId] = useState<string | null>(null);
	const [day, setDay] = useState<Weekday>("mon");
	const [startTime, setStartTime] = useState("07:30");
	const [endTime, setEndTime] = useState("09:30");
	const [title, setTitle] = useState("");
	const [category, setCategory] = useState<FixedEventCategory>("class");

	const [rawText, setRawText] = useState("");
	const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
	const [parsing, setParsing] = useState(false);

	const startEditEvent = (ev: FixedWeeklyEvent) => {
		setEditingId(ev.id);
		setDay(ev.dayOfWeek);
		setStartTime(ev.startTime);
		setEndTime(ev.endTime);
		setTitle(ev.title);
		setCategory(ev.category);
	};

	const cancelEditEvent = () => {
		setEditingId(null);
		setTitle("");
	};

	const saveManualOrEdit = async () => {
		if (!title.trim()) return;
		if (editingId) {
			const nextList = snap.config.fixedEvents.map((ev) =>
				ev.id !== editingId
					? ev
					: { ...ev, dayOfWeek: day, startTime, endTime, title: title.trim(), category },
			);
			await onSaveFixedEvents(nextList);
			setEditingId(null);
			setTitle("");
			return;
		}
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
				<div className={cn("rounded-xl border bg-card p-4", editingId && "border-primary/60 ring-1 ring-primary/30")}>
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-medium">
							{editingId ? "Edit Weekly Block" : "Method 1: Add to Weekly Grid (Manual · 0 tokens)"}
						</h3>
						{editingId && (
							<button type="button" onClick={cancelEditEvent} className="text-xs text-muted-foreground hover:underline">
								Cancel
							</button>
						)}
					</div>
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
							onClick={() => void saveManualOrEdit()}
							className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-40"
						>
							<PlusIcon className="size-3.5" /> {editingId ? "Save" : "Add"}
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
									<div
										key={ev.id}
										className={cn(
											"group relative rounded-lg border bg-muted/40 p-2 text-xs transition-colors hover:bg-muted/70",
											editingId === ev.id && "border-primary ring-1 ring-primary",
										)}
									>
										<button
											type="button"
											onClick={() => startEditEvent(ev)}
											className="w-full pr-10 text-left"
											title={`Edit ${ev.title}`}
										>
											<div className="text-[10px] font-medium tabular-nums text-muted-foreground">
												{ev.startTime}–{ev.endTime}
											</div>
											<div className="mt-0.5 truncate font-medium">{ev.title}</div>
										</button>
										<div className="absolute right-1 top-1 flex items-center gap-0.5">
											<button
												type="button"
												onClick={() => startEditEvent(ev)}
												aria-label={`Edit ${ev.title}`}
												className="rounded p-0.5 text-muted-foreground opacity-65 transition-opacity hover:text-foreground hover:opacity-100"
											>
												<PencilIcon className="size-3" />
											</button>
											<button
												type="button"
												onClick={() =>
													void onSaveFixedEvents(snap.config.fixedEvents.filter((x) => x.id !== ev.id))
												}
												aria-label={`Remove ${ev.title}`}
												className="rounded p-0.5 text-muted-foreground opacity-65 transition-opacity hover:text-destructive hover:opacity-100"
											>
												<TrashIcon className="size-3" />
											</button>
										</div>
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
	onOpenCoach,
	onError,
}: {
	snap: PlannerSnapshot;
	busy: boolean;
	onSaveLifestyle: (lifestyle: LifestyleConfig) => Promise<void>;
	onOpenCoach: (prefill?: string) => void;
	onError: (msg: string | null) => void;
}) {
	const [draft, setDraft] = useState<LifestyleConfig>(snap.config.lifestyle);
	const [newHobby, setNewHobby] = useState("");
	const [suggesting, setSuggesting] = useState(false);
	const [suggestionInfo, setSuggestionInfo] = useState<{ rationale: string; tips: string[]; modelLabel: string } | null>(null);

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

	const runSuggestLifestyle = async (useAi: boolean) => {
		setSuggesting(true);
		onError(null);
		try {
			const res = await fetch("/api/planner/suggest-lifestyle", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ useAi }),
			});
			const data = (await res.json()) as {
				hobbies?: string[];
				dailyHobbyMin?: number;
				gameBudgetMin?: number;
				gameCutoffBeforeBedMin?: number;
				windDownBufferMin?: number;
				allowMiddayRecoveryNap?: boolean;
				postDinnerComaProtection?: boolean;
				rationale?: string;
				tips?: string[];
				modelLabel?: string;
				error?: string;
			};
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			setDraft((prev) => ({
				...prev,
				...(data.hobbies && data.hobbies.length > 0 ? { hobbies: data.hobbies } : {}),
				...(typeof data.dailyHobbyMin === "number" ? { dailyHobbyMin: data.dailyHobbyMin } : {}),
				...(typeof data.gameBudgetMin === "number" ? { gameBudgetMin: data.gameBudgetMin } : {}),
				...(typeof data.gameCutoffBeforeBedMin === "number" ? { gameCutoffBeforeBedMin: data.gameCutoffBeforeBedMin } : {}),
				sleep: {
					...prev.sleep,
					...(typeof data.windDownBufferMin === "number" ? { windDownBufferMin: data.windDownBufferMin } : {}),
					...(typeof data.allowMiddayRecoveryNap === "boolean" ? { allowMiddayRecoveryNap: data.allowMiddayRecoveryNap } : {}),
					...(typeof data.postDinnerComaProtection === "boolean"
						? { postDinnerComaProtection: data.postDinnerComaProtection }
						: {}),
				},
			}));
			if (data.rationale) {
				setSuggestionInfo({
					rationale: data.rationale,
					tips: data.tips ?? [],
					modelLabel: data.modelLabel ?? "local",
				});
			}
		} catch (e) {
			onError(e instanceof Error ? e.message : "Could not optimize lifestyle settings.");
		} finally {
			setSuggesting(false);
		}
	};

	const guardrail = draft.wellnessGuardrail ?? {
		enabled: false,
		currentWeeklyFreq: 4,
		targetWeeklyFreq: 1,
		riskWindows: ["post_nap_wake", "early_morning_wake", "late_night", "post_stress"],
		replacementProtocol: "10m walk, pushups/water, offline book, phone outside bed",
		wakeUpAnchorProtocol: "Feet on floor <60s, cold water on face, step out of bedroom",
		cravingReframeNote: "Sleep-inertia wave peaks for 10–15m; prefrontal braking recovers as soon as I stand & walk.",
		deviceFrictionRules: ["No phone/laptop in bed", "Charge phone across room"],
	};

	const toggleRiskWindow = (win: string) => {
		const prevList = guardrail.riskWindows ?? [];
		const nextList = prevList.includes(win) ? prevList.filter((w) => w !== win) : [...prevList, win];
		setDraft({
			...draft,
			wellnessGuardrail: { ...guardrail, enabled: true, riskWindows: nextList },
		});
	};

	const toggleFrictionRule = (rule: string) => {
		const prevList = guardrail.deviceFrictionRules ?? [];
		const nextList = prevList.includes(rule) ? prevList.filter((r) => r !== rule) : [...prevList, rule];
		setDraft({
			...draft,
			wellnessGuardrail: { ...guardrail, enabled: true, deviceFrictionRules: nextList },
		});
	};

	return (
		<div className="grid gap-4 lg:grid-cols-12">
			<div className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-xs lg:col-span-7">
				<div>
					<div className="flex items-start justify-between gap-2">
						<div>
							<h3 className="text-sm font-medium">Sleep Anchor &amp; Continuity Recovery</h3>
							<p className="mt-0.5 text-muted-foreground">
								Handles both gradual bedtime shifting and 4–5 AM early-waking consolidation.
							</p>
						</div>
						<button
							type="button"
							onClick={() => onOpenCoach()}
							className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/15"
						>
							<MessageSquareTextIcon className="size-3" /> Chat Coach
						</button>
					</div>
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
							<label className="mb-1 block text-muted-foreground">Preferred Wake</label>
							<input
								type="time"
								value={draft.sleep.preferredWakeTime ?? "07:00"}
								onChange={(e) => setDraft({ ...draft, sleep: { ...draft.sleep, preferredWakeTime: e.target.value } })}
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
					</div>
					<div className="mt-2.5 grid grid-cols-2 gap-3 sm:grid-cols-3">
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
						<div>
							<label className="mb-1 block text-muted-foreground">Screen-off Wind-down (m)</label>
							<input
								type="number"
								min={15}
								max={60}
								step={5}
								value={draft.sleep.windDownBufferMin ?? 30}
								onChange={(e) =>
									setDraft({ ...draft, sleep: { ...draft.sleep, windDownBufferMin: Number(e.target.value) || 30 } })
								}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div className="col-span-2 flex flex-col justify-end gap-1 sm:col-span-1">
							<label className="flex items-center gap-1.5 text-[11px] text-foreground">
								<input
									type="checkbox"
									checked={Boolean(draft.sleep.earlyWakingIssue)}
									onChange={(e) => setDraft({ ...draft, sleep: { ...draft.sleep, earlyWakingIssue: e.target.checked } })}
								/>
								Early waking (4–5 AM)
							</label>
							<label className="flex items-center gap-1.5 text-[11px] text-foreground">
								<input
									type="checkbox"
									checked={draft.sleep.allowMiddayRecoveryNap ?? true}
									onChange={(e) =>
										setDraft({ ...draft, sleep: { ...draft.sleep, allowMiddayRecoveryNap: e.target.checked } })
									}
								/>
								25m midday recovery nap
							</label>
							<label className="flex items-center gap-1.5 text-[11px] text-foreground">
								<input
									type="checkbox"
									checked={Boolean(draft.sleep.postDinnerComaProtection)}
									onChange={(e) =>
										setDraft({ ...draft, sleep: { ...draft.sleep, postDinnerComaProtection: e.target.checked } })
									}
								/>
								Post-dinner dip shield (20–21h)
							</label>
							{draft.sleep.postDinnerComaProtection && (
								<div className="mt-1 flex items-center gap-1.5">
									<span className="text-[10px] text-muted-foreground">Dip starts:</span>
									<input
										type="time"
										value={draft.sleep.eveningDrowsyStart ?? "20:00"}
										onChange={(e) =>
											setDraft({ ...draft, sleep: { ...draft.sleep, eveningDrowsyStart: e.target.value } })
										}
										className="rounded border bg-background px-1.5 py-0.5 text-[11px]"
									/>
								</div>
							)}
						</div>
					</div>
				</div>

				<div className="border-t pt-3">
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-medium">Meals &amp; Midday Rest Slots</h3>
						<button
							type="button"
							onClick={() =>
								setDraft({
									...draft,
									meals: [
										...draft.meals,
										{ id: `meal_${Date.now()}`, label: "Meal / Rest", startTime: "15:30", durationMin: 30 },
									],
								})
							}
							className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent"
						>
							<PlusIcon className="size-3" /> Add slot
						</button>
					</div>
					<div className="mt-2 flex flex-col gap-2">
						{draft.meals.map((m, idx) => (
							<div key={m.id} className="flex flex-wrap items-center gap-2">
								<input
									type="text"
									value={m.label}
									onChange={(e) =>
										setDraft({
											...draft,
											meals: draft.meals.map((x, j) => (j === idx ? { ...x, label: e.target.value } : x)),
										})
									}
									placeholder="Meal name"
									className="min-w-28 flex-1 rounded-md border bg-background px-2 py-1"
								/>
								<input
									type="time"
									value={m.startTime}
									onChange={(e) =>
										setDraft({
											...draft,
											meals: draft.meals.map((x, j) => (j === idx ? { ...x, startTime: e.target.value } : x)),
										})
									}
									className="rounded-md border bg-background px-2 py-1"
								/>
								<input
									type="number"
									min={15}
									max={120}
									step={5}
									value={m.durationMin}
									onChange={(e) =>
										setDraft({
											...draft,
											meals: draft.meals.map((x, j) => (j === idx ? { ...x, durationMin: Number(e.target.value) || 30 } : x)),
										})
									}
									className="w-16 rounded-md border bg-background px-2 py-1"
									title="Duration (minutes)"
								/>
								<span className="text-[11px] text-muted-foreground">m</span>
								<button
									type="button"
									onClick={() =>
										setDraft({
											...draft,
											meals: draft.meals.filter((_, j) => j !== idx),
										})
									}
									aria-label={`Remove ${m.label}`}
									className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
								>
									<TrashIcon className="size-3.5" />
								</button>
							</div>
						))}
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

					<div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3">
						<div>
							<label className="mb-1 block text-muted-foreground">Bounded Gaming Budget (m/day)</label>
							<input
								type="number"
								min={0}
								max={180}
								step={10}
								value={draft.gameBudgetMin ?? 0}
								onChange={(e) => setDraft({ ...draft, gameBudgetMin: Number(e.target.value) || 0 })}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
						<div>
							<label className="mb-1 block text-muted-foreground">Game Cutoff Before Sleep (m)</label>
							<input
								type="number"
								min={30}
								max={240}
								step={15}
								value={draft.gameCutoffBeforeBedMin ?? 90}
								onChange={(e) => setDraft({ ...draft, gameCutoffBeforeBedMin: Number(e.target.value) || 90 })}
								className="w-full rounded-md border bg-background px-2 py-1"
							/>
						</div>
					</div>

					<details className="mt-3 rounded-lg border bg-muted/20 p-2.5">
						<summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
							Private Discipline &amp; Habit Moderation (Discreet · AI-assisted)
						</summary>
						<div className="mt-2.5 flex flex-col gap-2.5">
							<label className="flex items-center gap-2 text-xs text-foreground">
								<input
									type="checkbox"
									checked={Boolean(guardrail.enabled)}
									onChange={(e) =>
										setDraft({
											...draft,
											wellnessGuardrail: { ...guardrail, enabled: e.target.checked },
										})
									}
								/>
								Enable discreet frequency taper &amp; high-risk window scheduling guardrails (never shown overtly on timeline)
							</label>
							{guardrail.enabled && (
								<>
									<div className="grid grid-cols-2 gap-2">
										<div>
											<label className="mb-0.5 block text-[11px] text-muted-foreground">Current Weekly Freq</label>
											<input
												type="number"
												min={0}
												max={30}
												value={guardrail.currentWeeklyFreq ?? 4}
												onChange={(e) =>
													setDraft({
														...draft,
														wellnessGuardrail: { ...guardrail, currentWeeklyFreq: Number(e.target.value) || 0 },
													})
												}
												className="w-full rounded border bg-background px-2 py-1"
											/>
										</div>
										<div>
											<label className="mb-0.5 block text-[11px] text-muted-foreground">Healthy Target Freq (/wk)</label>
											<input
												type="number"
												min={0}
												max={21}
												value={guardrail.targetWeeklyFreq ?? 1}
												onChange={(e) =>
													setDraft({
														...draft,
														wellnessGuardrail: { ...guardrail, targetWeeklyFreq: Number(e.target.value) || 0 },
													})
												}
												className="w-full rounded border bg-background px-2 py-1"
											/>
										</div>
									</div>
									<div>
										<div className="mb-1 text-[11px] text-muted-foreground">High-risk Trigger Windows:</div>
										<div className="flex flex-wrap gap-1.5">
											{[
												{ id: "post_nap_wake", label: "Right after midday nap" },
												{ id: "early_morning_wake", label: "Early morning wake" },
												{ id: "post_dinner_slump", label: "Evening food coma" },
												{ id: "late_night", label: "Late night" },
												{ id: "post_stress", label: "After tough study" },
												{ id: "idle_afternoon", label: "Idle afternoon" },
												{ id: "alone_in_room", label: "Phone in bed" },
											].map((w) => {
												const active = (guardrail.riskWindows ?? []).includes(w.id);
												return (
													<button
														key={w.id}
														type="button"
														onClick={() => toggleRiskWindow(w.id)}
														className={cn(
															"rounded border px-2 py-0.5 text-[11px]",
															active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
														)}
													>
														{w.label}
													</button>
												);
											})}
										</div>
									</div>
									<div>
										<label className="mb-0.5 block text-[11px] text-muted-foreground">Wake / Post-Nap &lt;60s Anchor</label>
										<input
											type="text"
											value={guardrail.wakeUpAnchorProtocol ?? ""}
											onChange={(e) =>
												setDraft({
													...draft,
													wellnessGuardrail: { ...guardrail, wakeUpAnchorProtocol: e.target.value },
												})
											}
											placeholder="e.g. Feet on floor <60s, cold water on face, leave bed before phone..."
											className="w-full rounded border bg-background px-2 py-1"
										/>
									</div>
									<div>
										<label className="mb-0.5 block text-[11px] text-muted-foreground">Replacement Reset Protocol</label>
										<input
											type="text"
											value={guardrail.replacementProtocol ?? ""}
											onChange={(e) =>
												setDraft({
													...draft,
													wellnessGuardrail: { ...guardrail, replacementProtocol: e.target.value },
												})
											}
											placeholder="e.g. 10m walk, pushups + cold water, offline book..."
											className="w-full rounded border bg-background px-2 py-1"
										/>
									</div>
									<div>
										<label className="mb-0.5 block text-[11px] text-muted-foreground">Private Grounding Cue (for 10m Reset Timer)</label>
										<input
											type="text"
											value={guardrail.cravingReframeNote ?? ""}
											onChange={(e) =>
												setDraft({
													...draft,
													wellnessGuardrail: { ...guardrail, cravingReframeNote: e.target.value },
												})
											}
											placeholder="e.g. Sleep-inertia wave fades in 10–15m once I stand & walk..."
											className="w-full rounded border bg-background px-2 py-1"
										/>
									</div>
									<div>
										<div className="mb-1 text-[11px] text-muted-foreground">Environment Friction Rules:</div>
										<div className="flex flex-wrap gap-1.5">
											{[
												"No phone/laptop in bed",
												"Charge phone across room",
												"10-min room-exit after nap",
												"Seated / desk power-nap only",
											].map((rule) => {
												const active = (guardrail.deviceFrictionRules ?? []).includes(rule);
												return (
													<button
														key={rule}
														type="button"
														onClick={() => toggleFrictionRule(rule)}
														className={cn(
															"rounded border px-2 py-0.5 text-[11px]",
															active ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
														)}
													>
														{rule}
													</button>
												);
											})}
										</div>
									</div>
									<div className="pt-1">
										<button
											type="button"
											onClick={() =>
												onOpenCoach(
													"Tôi hay bị food coma buồn ngủ 8–9h tối sau ăn và đôi lúc có cơn libido bứt rứt / craving muốn xả ngay sau khi ngủ trưa dậy hoặc sáng sớm — hãy điều chỉnh lịch ăn/ngủ/học, thêm transition anchor và chiến lược vượt qua giúp tôi",
												)
											}
											className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
										>
											Tailor Anti-Dip &amp; Impulse Plan with AI Coach →
										</button>
									</div>
								</>
							)}
						</div>
					</details>

					<label className="mt-3 flex items-center gap-2 text-xs text-foreground">
						<input
							type="checkbox"
							checked={draft.strictSwitchWarning}
							onChange={(e) => setDraft({ ...draft, strictSwitchWarning: e.target.checked })}
						/>
						Enable soft-strict subject switch prompt when a study block finishes
					</label>

					{suggestionInfo && (
						<div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-[11px]">
							<div className="flex items-center justify-between font-medium text-foreground">
								<span>Suggested Lifestyle Balance</span>
								<span className="text-[10px] text-muted-foreground">{suggestionInfo.modelLabel}</span>
							</div>
							<p className="mt-1 text-foreground">{suggestionInfo.rationale}</p>
							{suggestionInfo.tips.length > 0 && (
								<ul className="mt-1 space-y-0.5 text-muted-foreground">
									{suggestionInfo.tips.map((t, i) => (
										<li key={i}>• {t}</li>
									))}
								</ul>
							)}
						</div>
					)}
				</div>

				<div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							disabled={suggesting || busy}
							onClick={() => void runSuggestLifestyle(false)}
							className="rounded-md border px-2.5 py-1.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
						>
							{suggesting ? "..." : "Suggest Balance (0t)"}
						</button>
						<button
							type="button"
							disabled={suggesting || busy || !snap.aiAvailability.coach.available}
							onClick={() => void runSuggestLifestyle(true)}
							title={snap.aiAvailability.coach.available ? `Uses ${snap.aiAvailability.coach.modelLabel}` : "Configure model key first"}
							className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2.5 py-1.5 font-medium hover:bg-accent disabled:opacity-40"
						>
							<SparklesIcon className="size-3 text-primary" /> Optimize with AI
						</button>
						<button
							type="button"
							onClick={() => onOpenCoach()}
							className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 font-medium text-primary hover:bg-accent"
						>
							<MessageSquareTextIcon className="size-3" /> Side Coach
						</button>
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={() => void onSaveLifestyle(draft)}
						className="rounded-md bg-primary px-4 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
					>
						Save Lifestyle &amp; Recompute Plan
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

function JournalAuditTab({
	snap,
	busy,
	onCheckIn,
	onSnapshotUpdate,
	onError,
}: {
	snap: PlannerSnapshot;
	busy: boolean;
	onCheckIn: (payload: Record<string, unknown>) => Promise<void>;
	onSnapshotUpdate: (next: PlannerSnapshot) => void;
	onError: (msg: string | null) => void;
}) {
	const [selectedDate, setSelectedDate] = useState(snap.plan.date);
	const [historySearch, setHistorySearch] = useState("");
	const activeLog = snap.config.logs[selectedDate];

	const [journalText, setJournalText] = useState(activeLog?.journalText ?? "");
	const [manualEntries, setManualEntries] = useState<JournalActivityEntry[]>(() =>
		(activeLog?.actualEntries ?? []).filter((e) => e.source === "manual"),
	);
	const [auditMode, setAuditMode] = useState<"local" | "llm">("local");
	const [preferredRole, setPreferredRole] = useState("");
	const [evaluating, setEvaluating] = useState(false);

	// Manual activity add bar
	const [actStart, setActStart] = useState("08:30");
	const [actEnd, setActEnd] = useState("10:00");
	const [actCat, setActCat] = useState<JournalActivityCategory>("study");
	const [actSubj, setActSubj] = useState(snap.plan.quotas[0]?.subject ?? "");
	const [actTitle, setActTitle] = useState("");

	useEffect(() => {
		const log = snap.config.logs[selectedDate];
		setJournalText(log?.journalText ?? "");
		setManualEntries((log?.actualEntries ?? []).filter((e) => e.source === "manual"));
	}, [selectedDate, snap.config.logs]);

	const historyDates = useMemo(() => {
		const needle = historySearch.trim().toLowerCase();
		const dates = new Set<string>([snap.plan.date, ...Object.keys(snap.config.logs)]);
		return [...dates]
			.sort((a, b) => b.localeCompare(a))
			.filter((d) => {
				if (!needle) return true;
				const log = snap.config.logs[d];
				const hay = `${d} ${log?.journalText ?? ""} ${log?.compliance?.summary ?? ""} ${Object.keys(log?.loggedStudyMinBySubject ?? {}).join(" ")}`.toLowerCase();
				return hay.includes(needle);
			});
	}, [snap.plan.date, snap.config.logs, historySearch]);

	const addManualEntry = () => {
		const sMin = parseClockMin(actStart);
		let eMin = parseClockMin(actEnd);
		if (sMin === null || eMin === null) return;
		if (eMin <= sMin) eMin += 1440;
		const titleTrim = actTitle.trim() || actSubj.trim() || "Logged activity";
		const entry: JournalActivityEntry = {
			id: `jm_${selectedDate}_${Date.now()}`,
			startTime: formatClockMin(sMin),
			endTime: formatClockMin(eMin),
			category: actCat,
			...(actSubj.trim() && (actCat === "study" || actCat === "class") ? { subject: actSubj.trim() } : {}),
			title: titleTrim,
			minutes: Math.max(5, eMin - sMin),
			source: "manual",
		};
		setManualEntries((prev) => [...prev, entry]);
		setActTitle("");
	};

	const removeManualEntry = (id: string) => {
		setManualEntries((prev) => prev.filter((e) => e.id !== id));
	};

	const saveDraftOnly = async () => {
		await onCheckIn({
			date: selectedDate,
			journalText,
			actualEntries: [
				...manualEntries,
				...(activeLog?.actualEntries ?? []).filter((e) => e.source !== "manual"),
			],
		});
	};

	const runAudit = async () => {
		setEvaluating(true);
		onError(null);
		try {
			const res = await fetch("/api/planner/evaluate-day", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					date: selectedDate,
					journalText,
					manualEntries,
					mode: auditMode,
					...(auditMode === "llm" && preferredRole ? { preferredRole } : {}),
				}),
			});
			const data = (await res.json()) as {
				snapshot?: PlannerSnapshot;
				report?: PlanComplianceReport;
				error?: string;
			};
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			if (data.snapshot) onSnapshotUpdate(data.snapshot);
		} catch (e) {
			onError(e instanceof Error ? e.message : "Failed to audit 24h journal.");
		} finally {
			setEvaluating(false);
		}
	};

	const compliance = activeLog?.compliance;
	const displayEntries = activeLog?.actualEntries && activeLog.actualEntries.length > 0 ? activeLog.actualEntries : manualEntries;
	const dayPlan = snap.config.plans[selectedDate] ?? (selectedDate === snap.plan.date ? snap.plan : undefined);

	return (
		<div className="grid gap-4 lg:grid-cols-12 text-xs">
			{/* Left: Date Selector + Long-Term 365-Day History Browser */}
			<div className="flex flex-col gap-3 rounded-xl border bg-card p-3.5 lg:col-span-4">
				<div className="flex items-center justify-between gap-2">
					<span className="inline-flex items-center gap-1.5 text-sm font-medium">
						<BookOpenIcon className="size-4 text-primary" /> 24h History ({historyDates.length}d)
					</span>
					<input
						type="date"
						value={selectedDate}
						onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
						className="rounded border bg-background px-2 py-1 text-[11px]"
					/>
				</div>
				<div className="relative">
					<SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
					<input
						type="text"
						value={historySearch}
						onChange={(e) => setHistorySearch(e.target.value)}
						placeholder="Search past logs, subjects, notes..."
						className="w-full rounded-md border bg-background py-1.5 pr-2 pl-8 text-xs"
					/>
				</div>
				<div className="flex max-h-[380px] flex-col gap-1.5 overflow-y-auto">
					{historyDates.map((d) => {
						const l = snap.config.logs[d];
						const mins = Object.values(l?.loggedStudyMinBySubject ?? {}).reduce((a, b) => a + b, 0);
						const adh = l?.compliance?.adherencePct;
						return (
							<button
								key={d}
								type="button"
								onClick={() => setSelectedDate(d)}
								className={cn(
									"flex items-center justify-between rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-accent/50",
									selectedDate === d ? "border-primary bg-primary/5" : "bg-muted/20",
								)}
							>
								<div className="min-w-0">
									<div className="font-medium text-foreground">
										{d} {d === snap.plan.date ? "(Today)" : ""}
									</div>
									<div className="truncate text-[10px] text-muted-foreground">
										{l?.journalText ? l.journalText.slice(0, 42) : l?.note ? l.note.slice(0, 42) : "No journal yet"}
									</div>
								</div>
								<div className="shrink-0 text-right">
									<div className="font-medium tabular-nums">{formatMinCompact(mins)}</div>
									{adh !== undefined && (
										<span
											className={cn(
												"inline-block rounded px-1 text-[10px] tabular-nums",
												adh >= 75 ? "bg-success/10 text-success" : adh >= 45 ? "bg-warning/10 text-warning" : "bg-error/10 text-error",
											)}
										>
											{adh}%
										</span>
									)}
								</div>
							</button>
						);
					})}
				</div>
			</div>

			{/* Right: 24h Freeform Diary + Structured Entries + Plan-vs-Actual Compliance Audit */}
			<div className="flex flex-col gap-3 rounded-xl border bg-card p-3.5 lg:col-span-8">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h3 className="text-sm font-medium">24h Reality Journal — {selectedDate}</h3>
						<p className="text-[11px] text-muted-foreground">
							{dayPlan
								? `Planned: ${dayPlan.plannedStudyHours}h (${dayPlan.quotas.map((q) => q.subject).join(", ") || "open"})`
								: "Record your actual day; audited adherence gently tunes future realism capacity."}
							{snap.config.realismFactor !== undefined && snap.config.realismFactor !== 1
								? ` · Current EWMA capacity: ${Math.round(snap.config.realismFactor * 100)}%`
								: ""}
						</p>
					</div>
					<div className="flex items-center gap-1 rounded-lg border bg-background p-0.5 text-[11px]">
						<button
							type="button"
							onClick={() => setAuditMode("local")}
							className={cn(
								"rounded-md px-2 py-1 transition-colors",
								auditMode === "local" ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							Local · 0 tokens
						</button>
						<button
							type="button"
							disabled={!snap.aiAvailability.coach.available}
							onClick={() => setAuditMode("llm")}
							title={snap.aiAvailability.coach.available ? `AI model: ${snap.aiAvailability.coach.modelLabel}` : "Configure model key in Settings first"}
							className={cn(
								"inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors disabled:opacity-40",
								auditMode === "llm" ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							<SparklesIcon className="size-3" /> AI Auditor
						</button>
					</div>
				</div>

				{auditMode === "llm" && snap.aiAvailability.availableRoles && snap.aiAvailability.availableRoles.length > 0 && (
					<div className="flex items-center justify-between gap-2 rounded-md border bg-muted/25 px-2.5 py-1.5 text-[11px]">
						<span className="text-muted-foreground">Auditor Model:</span>
						<select
							value={preferredRole}
							onChange={(e) => setPreferredRole(e.target.value)}
							className="rounded border bg-background px-2 py-0.5 text-[11px]"
						>
							<option value="">Auto ({snap.aiAvailability.coach.modelLabel ?? "coach"})</option>
							{snap.aiAvailability.availableRoles.map((r) => (
								<option key={r.role} value={r.role}>
									{r.label}: {r.modelLabel}
								</option>
							))}
						</select>
					</div>
				)}

				<textarea
					rows={5}
					value={journalText}
					onChange={(e) => setJournalText(e.target.value)}
					placeholder={"Write freely what actually happened across 24h (one per line or timestamps), e.g.:\n08:30-11:00 Giải 3 bài dãy số Giải tích Olympic\n12:00-13:00 Ăn trưa + nghỉ\n14:00-15:00 Mệt nên lướt điện thoại / chợp mắt\n20:00-21:45 Ôn FSRS Đại số + sửa mistake rule"}
					className="w-full rounded-lg border bg-background p-2.5 text-xs leading-relaxed"
				/>

				{/* Quick structured log row */}
				<div className="rounded-lg border bg-muted/20 p-2.5">
					<div className="mb-1.5 text-[11px] font-medium text-muted-foreground">+ Add Explicit Timeline Entry (Optional)</div>
					<div className="grid grid-cols-2 gap-1.5 sm:grid-cols-6">
						<input type="time" value={actStart} onChange={(e) => setActStart(e.target.value)} className="rounded border bg-background px-2 py-1" />
						<input type="time" value={actEnd} onChange={(e) => setActEnd(e.target.value)} className="rounded border bg-background px-2 py-1" />
						<select
							value={actCat}
							onChange={(e) => setActCat(e.target.value as JournalActivityCategory)}
							className="rounded border bg-background px-1.5 py-1"
						>
							<option value="study">Study</option>
							<option value="class">Class</option>
							<option value="sleep">Sleep</option>
							<option value="meal">Meal</option>
							<option value="hobby">Hobby</option>
							<option value="rest">Rest</option>
							<option value="distraction">Distraction</option>
						</select>
						<input
							type="text"
							value={actSubj}
							onChange={(e) => setActSubj(e.target.value)}
							placeholder="Subject..."
							className="rounded border bg-background px-2 py-1"
						/>
						<input
							type="text"
							value={actTitle}
							onChange={(e) => setActTitle(e.target.value)}
							placeholder="What you did..."
							className="rounded border bg-background px-2 py-1"
						/>
						<button
							type="button"
							onClick={addManualEntry}
							className="inline-flex items-center justify-center gap-1 rounded border bg-card px-2 py-1 font-medium hover:bg-accent"
						>
							<PlusIcon className="size-3" /> Add
						</button>
					</div>
					{manualEntries.length > 0 && (
						<div className="mt-2 flex flex-wrap gap-1">
							{manualEntries.map((m) => (
								<span key={m.id} className="inline-flex items-center gap-1 rounded border bg-card px-2 py-0.5 text-[11px]">
									<span>{m.startTime}-{m.endTime} {m.category}: {m.title}</span>
									<button type="button" onClick={() => removeManualEntry(m.id)} className="text-muted-foreground hover:text-error">
										<XIcon className="size-3" />
									</button>
								</span>
							))}
						</div>
					)}
				</div>

				<div className="flex flex-wrap items-center justify-end gap-2">
					<button
						type="button"
						disabled={busy || evaluating}
						onClick={() => void saveDraftOnly()}
						className="rounded-md border px-3 py-1.5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
					>
						Save Draft Only
					</button>
					<button
						type="button"
						disabled={busy || evaluating}
						onClick={() => void runAudit()}
						className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
					>
						{evaluating ? <BrailleSpinner /> : <ScaleIcon className="size-3.5" />}
						Save & Score Plan vs Actual ({auditMode === "llm" ? "AI" : "0 tokens"})
					</button>
				</div>

				{compliance && (
					<div className="rounded-xl border bg-muted/25 p-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2">
								<span className="text-sm font-semibold text-foreground">
									Plan vs Actual Adherence: <span className="text-primary">{compliance.adherencePct}%</span>
								</span>
								<span className="rounded border bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground">
									{compliance.evaluatedBy === "llm" ? compliance.modelLabel ?? "AI Auditor" : "Local · 0 tokens"}
								</span>
							</div>
							<span className="tabular-nums text-[11px] text-muted-foreground">
								Actual {(compliance.actualStudyMin / 60).toFixed(1)}h / Planned {(compliance.plannedStudyMin / 60).toFixed(1)}h · Realism ×{compliance.realismRatio}
							</span>
						</div>
						<p className="mt-1.5 text-foreground">{compliance.summary}</p>
						<div className="mt-2 grid gap-2 sm:grid-cols-2">
							{compliance.strengths.length > 0 && (
								<div className="rounded-lg border bg-card p-2">
									<div className="mb-1 text-[11px] font-medium text-success">Strengths</div>
									<ul className="space-y-0.5 text-[11px] text-muted-foreground">
										{compliance.strengths.map((s, i) => (
											<li key={i}>• {s}</li>
										))}
									</ul>
								</div>
							)}
							{compliance.frictionPoints.length > 0 && (
								<div className="rounded-lg border bg-card p-2">
									<div className="mb-1 text-[11px] font-medium text-warning">Friction & Distractions</div>
									<ul className="space-y-0.5 text-[11px] text-muted-foreground">
										{compliance.frictionPoints.map((f, i) => (
											<li key={i}>• {f}</li>
										))}
									</ul>
								</div>
							)}
						</div>
						{compliance.nextDayAdvice && (
							<div className="mt-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px] text-foreground">
								<strong>Next-day calibration:</strong> {compliance.nextDayAdvice}
							</div>
						)}
					</div>
				)}

				{displayEntries.length > 0 && (
					<div className="rounded-xl border bg-muted/20 p-2.5">
						<div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
							Extracted 24h Reality Timeline ({displayEntries.length} entries)
						</div>
						<div className="grid gap-1 sm:grid-cols-2">
							{displayEntries.map((ent) => (
								<div key={ent.id} className="flex items-center justify-between gap-2 rounded border bg-card px-2 py-1 text-[11px]">
									<span className="min-w-0 truncate">
										<span className="font-medium tabular-nums text-muted-foreground">{ent.startTime}–{ent.endTime}</span>{" "}
										<span className="rounded border px-1 py-0 text-[9px] uppercase">{ent.category}</span>{" "}
										{ent.subject ? `[${ent.subject}] ` : ""}
										{ent.title}
									</span>
									<span className="shrink-0 tabular-nums text-muted-foreground">{ent.minutes}m</span>
								</div>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

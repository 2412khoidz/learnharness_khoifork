import type { ExamPrepConfig, ExamPrepMistakeHints, ExamPrepStatus } from "./exam-prep.ts";

/**
 * Student Study OS / Study Planner domain logic — 100% pure & browser-safe.
 *
 * Powers both:
 * 1. Deterministic local scheduling (`computeLocalPlannerPlan`, 0 tokens):
 *    computes free awake time after fixed weekly classes/events, meals,
 *    hobbies/rest, and sleep anchor recovery, scores urgency across exams,
 *    competitions, projects, deadlines, FSRS due cards, Graph weak/untracked
 *    foundations, recurring mistakes, and stale sessions, then schedules
 *    cognitive-matched focus blocks + breaks + soft subject switching.
 * 2. Token-optimized LLM Coach digest & strict validation
 *    (`buildCompactPlannerDigest` / `applyLlmPlanOutput`).
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
	mon: "Mon",
	tue: "Tue",
	wed: "Wed",
	thu: "Thu",
	fri: "Fri",
	sat: "Sat",
	sun: "Sun",
};

export type PlannerEngineMode = "local" | "llm";
export type PlannerIntensity = "healthy" | "balanced" | "intensive";
export type MilestoneKind = "exam" | "competition" | "project" | "deadline";
export type CognitiveLoad = "heavy" | "medium" | "light";
export type FixedEventCategory = "class" | "club" | "work" | "commute" | "other";
export type PeakFocusWindow = "auto" | "morning" | "afternoon" | "evening";

export interface FixedWeeklyEvent {
	id: string;
	dayOfWeek: Weekday;
	startTime: string; // HH:MM
	endTime: string; // HH:MM
	title: string;
	category: FixedEventCategory;
}

/** Exam calendar entry independent of study milestones and Exam Prep profiles. */
export interface ExamTimetableEntry {
 id: string;
 title: string;
 date?: string;
 startTime?: string;
 endTime?: string;
 location?: string;
 courseCode?: string;
 examType?: string;
 format?: string;
 session?: string;
 seat?: string;
 notes?: string;
}

export interface CoachAttachment { id: string; name: string; mimeType: string; size: number }

export interface SyllabusTopic {
	id: string;
	title: string;
	estHours: number;
	done: boolean;
}

export interface StudyMilestone {
	id: string;
	kind: MilestoneKind;
	title: string;
	subject: string;
	dueDate: string; // YYYY-MM-DD
	priority: 1 | 2 | 3; // 3 = highest (competitions / critical exams)
	cognitiveLoad: CognitiveLoad;
	clusterIds: string[];
	estimatedHours: number;
	completedHours: number;
	syllabusTopics: SyllabusTopic[];
	notes: string;
	sourceSummary?: string;
	examProfileId?: string;
}

export interface MealSlot {
	id: string;
	label: string;
	startTime: string; // HH:MM
	durationMin: number;
}

export interface SleepRecoveryProfile {
	currentBedtime: string; // HH:MM (can be late night e.g. "03:30")
	targetBedtime: string; // HH:MM (e.g. "23:30")
	targetSleepHours: number; // e.g. 7.5
	shiftStepMinPerDay: number; // e.g. 30 min earlier per day toward target
	peakFocusWindow: PeakFocusWindow;
	earlyWakingIssue?: boolean; // wakes up at 4-5 AM unintentionally -> adjust wind-down & midday recovery
	preferredWakeTime?: string; // HH:MM e.g. "07:00"
	windDownBufferMin?: number; // screen-free cutoff before sleep (20-60m, default 30m)
	allowMiddayRecoveryNap?: boolean; // 20-25m restorative nap after lunch when sleep < goal
	postDinnerComaProtection?: boolean; // post-dinner 15m walk + light-load 20:00-21:15 dip window
	eveningDrowsyStart?: string; // optional HH:MM (e.g. "20:00") when post-dinner coma hits
}

export interface WellnessGuardrailConfig {
	enabled: boolean;
	currentWeeklyFreq?: number; // confidential baseline weekly frequency
	targetWeeklyFreq?: number; // target healthier weekly frequency
	riskWindows?: string[]; // e.g. "post_nap_wake" | "early_morning_wake" | "post_dinner_slump" | "late_night" | "post_stress" | "idle_afternoon" | "alone_in_room"
	replacementProtocol?: string; // healthy decompression swap, e.g. "10m walk + pushups/water"
	wakeUpAnchorProtocol?: string; // <60s feet-on-floor morning/post-nap transition routine
	cravingReframeNote?: string; // private 1-sentence grounding cue shown in reset timer / coach
	deviceFrictionRules?: string[]; // e.g. "No phone in bed", "Charge phone outside bedroom"
}

export interface LifestyleConfig {
	sleep: SleepRecoveryProfile;
	meals: MealSlot[];
	hobbies: string[];
	hobbyPreferences?: Record<string, { dailyMin: number; preferredWindow: "auto" | "morning" | "afternoon" | "evening" }>;
	dailyHobbyMin: number; // user baseline; adjusted gently per intensity
	gameBudgetMin?: number; // bounded guilt-free gaming window (scheduled before bedtime cutoff)
	gameCutoffBeforeBedMin?: number; // min minutes before bedtime when gaming/screens stop (default 90m)
	wellnessGuardrail?: WellnessGuardrailConfig;
	blockDurationMin: number; // default 50
	breakDurationMin: number; // default 10
	strictSwitchWarning: boolean;
}

export type JournalActivityCategory =
	| "study"
	| "class"
	| "sleep"
	| "meal"
	| "hobby"
	| "rest"
	| "distraction"
	| "other";

export interface JournalActivityEntry {
	id: string;
	startTime: string; // HH:MM
	endTime: string; // HH:MM
	category: JournalActivityCategory;
	subject?: string;
	title: string;
	minutes: number;
	source: "manual" | "parsed_text" | "ai_extracted";
}

export interface PlanComplianceReport {
	date: string;
	evaluatedAt: string;
	evaluatedBy: "local" | "llm";
	modelLabel?: string;
	/** AI prose is retained even when its numbers disagree with the recorded timeline. */
	numericMismatch?: boolean;
	adherencePct: number;
	/** False when no study was due, so no percentage can be meaningfully calculated. */
	scorable?: boolean;
	plannedStudyMin: number;
	actualStudyMin: number;
	realismRatio: number;
	summary: string;
	strengths: string[];
	frictionPoints: string[];
	nextDayAdvice: string;
}

export interface DailyHabitLog {
	date: string; // YYYY-MM-DD
	actualBedtime?: string;
	actualWakeTime?: string;
	sleepQuality?: 1 | 2 | 3 | 4 | 5;
	wokeEarlyUnintended?: boolean;
	energyScore?: 1 | 2 | 3 | 4 | 5;
	foodComaHitToday?: boolean;
	urgesSurfed?: number;
	urgeTriggerWindows?: string[];
	completedBlockIds: string[];
	completedChecklistIds: string[];
	loggedStudyMinBySubject: Record<string, number>;
	hobbyDone: boolean;
	mealsOk: boolean;
	sleepOnTarget?: boolean;
	note?: string;
	journalText?: string;
	actualEntries?: JournalActivityEntry[];
	/** Explicitly recorded counts; no time or duration is inferred. */
	habitCounts?: Array<{ id: string; name: string; count: number }>;
	compliance?: PlanComplianceReport;
	updatedAt?: string;
}

export interface PlannedBlock {
	id: string;
	date: string;
	startTime: string; // HH:MM (may wrap past midnight if bedtime > 24:00, formatted HH:MM)
	endTime: string; // HH:MM
	startMin: number; // monotonic minutes from 00:00 of `date` (can exceed 1440 past midnight)
	endMin: number;
	durationMin: number;
	type: "study" | "break" | "hobby" | "meal" | "sleep" | "fixed";
	title: string;
	subject?: string;
	milestoneId?: string;
	cognitiveLoad?: CognitiveLoad;
	reason?: string;
	strictSwitch?: boolean;
	actionTopic?: string;
	recallFocus?: RecallWorkloadFocus;
}

export interface RecallWorkloadFocus {
	topic: string;
	minutes: number;
	mode: "recheck" | "practice";
	task?: string;
}

export interface CapacityCalibrationUndo {
	id: string;
	date: string;
	realism?: { before: number | null; after: number };
	blocks: Array<{ id: string; date: string; revision: string; before?: RecallWorkloadFocus; after: RecallWorkloadFocus }>;
}

export interface QuotaChecklistItem {
	id: string;
	text: string;
}

export interface DailyQuotaItem {
	id: string;
	subject: string;
	milestoneId?: string;
	targetMin: number;
	urgencyScore: number;
	paceMultiplier?: number;
	weaknessSummary?: string;
	checklist: QuotaChecklistItem[];
}

export interface HabitStrengthSummary {
	overallPct: number;
	sleepPct: number;
	studyPct: number;
	mealsPct: number;
	hobbyPct: number;
	circadianDriftMin: number;
	cycleWakeSuggestions: string[];
}

export interface WeeklyForecastSubjectQuota {
	subject: string;
	plannedMinutes: number;
	focusHint?: string;
	isExamPriority?: boolean;
}

export interface WeeklyForecastDay {
	date: string;
	weekday: Weekday;
	freeHours: number;
	plannedHours: number;
	loadLevel: "light" | "moderate" | "heavy";
	milestoneTitles: string[];
	subjects?: WeeklyForecastSubjectQuota[];
	carryoverInMinutes?: number;
	isCustomEdited?: boolean;
}

export interface DailyStudyPlan {
	date: string;
	generatedAt: string;
	engineUsed: PlannerEngineMode;
	intensity: PlannerIntensity;
	minDailyStudyHours: number;
	plannedStudyHours: number;
	freeHoursTotal: number;
	recommendedBedtime: string;
	recommendedWakeTime: string;
	todayWakeTime: string;
	sleepShiftAdvice: string;
	daysToSleepTarget: number;
	quotas: DailyQuotaItem[];
	blocks: PlannedBlock[];
	habitStrength?: HabitStrengthSummary;
	weeklyForecast?: WeeklyForecastDay[];
	carryoverNote?: string;
	realismApplied?: number;
	activeFocusSubjects?: string[];
	examDeficitWarning?: string;
	isCustomEdited?: boolean;
	coachSummary?: string;
	modelUsed?: string;
}

export interface DayOneOffEvent {
	id: string;
	startTime: string; // HH:MM
	endTime: string; // HH:MM
	title: string;
	category: FixedEventCategory;
}

export interface DayOverride {
	date: string; // YYYY-MM-DD
	skipFixedEvents?: boolean;
	extraBusyEvents?: DayOneOffEvent[];
	note?: string;
	studyTargetHoursOverride?: number;
	wakeTime?: string;
	bedTime?: string;
	meals?: MealSlot[];
	focusSubjects?: string[];
	customBlocks?: PlannedBlock[];
}

export interface CoachChatAppliedChange {
	id: string;
	summary: string;
	patchLabels: string[];
	reverted?: boolean;
}

export interface CoachChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	timestamp: string;
	attachments?: CoachAttachment[];
	focusArea?: "schedule" | "lifestyle" | "general";
	modelLabel?: string;
	appliedChange?: CoachChatAppliedChange;
	error?: string;
}

export interface CoachUndoSnapshot {
	messageId: string;
	date: string;
	prevDayOverride?: DayOverride;
	hadDayOverride: boolean;
	prevLifestyle: LifestyleConfig;
	prevIntensity: PlannerIntensity;
	prevLog?: DailyHabitLog;
	hadLog: boolean;
	prevMutedSubjects?: string[];
	prevPinnedSubjects?: string[];
	/** Full reversible state for the expanded Coach operations, excluding chat and nested undo. */
	beforePlanner?: PlannerConfig;
	afterPlanner?: PlannerConfig;
	beforeExam?: import("./exam-prep.ts").ExamPrepConfig;
	afterExam?: import("./exam-prep.ts").ExamPrepConfig;
	sessionChanges?: Array<{ id: string; before: CoachSessionMetadata; after: CoachSessionMetadata }>;
	graphChanges?: CoachGraphChange[];
	beforeSettings?: import("./settings.ts").UserSettings;
	afterSettings?: import("./settings.ts").UserSettings;
}

export interface CoachSessionMetadata { title: string; notes: string; pinned: boolean; archived: boolean }
export interface CoachGraphChange { id: string; before: { name: string; statement: string }; after: { name: string; statement: string }; beforeHash: string; afterHash: string }

export interface PlannerConfig {
	version: 1;
	engineMode: PlannerEngineMode;
	intensity: PlannerIntensity;
	fixedEvents: FixedWeeklyEvent[];
	examTimetable: ExamTimetableEntry[];
	milestones: StudyMilestone[];
	lifestyle: LifestyleConfig;
	logs: Record<string, DailyHabitLog>;
	plans: Record<string, DailyStudyPlan>;
	planHistory?: Record<string, Array<{ replacedAt: string; plan: DailyStudyPlan }>>;
	dayOverrides?: Record<string, DayOverride>;
	dismissedExamProfileIds?: string[];
	mutedSubjects?: string[];
	pinnedSubjects?: string[];
	dailyMaxSubjects?: number;
	realismFactor?: number;
	coachChat?: CoachChatMessage[];
	lastCoachUndo?: CoachUndoSnapshot;
	lastCapacityCalibration?: CapacityCalibrationUndo;
	updatedAt: string;
}

export interface PlannerSubjectSignal {
	clusterId: string;
	label: string;
	nodeCount: number;
	trackedCount: number;
	dueCount: number;
	weakCount: number;
	untrackedCount: number;
	readinessPct: number;
	dueSampleNames: string[];
	weakSampleNames: string[];
	untrackedSampleNames?: string[];
	attachedFiles?: string[];
	activePlanTopics?: string[];
	pendingProblems?: string[];
	sessionNotesPreview?: string;
	recentChatTitles: string[];
	lastStudiedAt: string | null;
}

export interface PlannerSessionSummary {
	id: string;
	title: string;
	kind?: "teach" | "practice";
	updatedAt: string;
}

export interface SubjectLearningMetrics {
	subject: string;
	clusterId?: string;
	fsrsReviews: number;
	fsrsTrackedNodes: number;
	retentionRatePct: number | null;
	lapseRatePct: number | null;
	avgDifficulty: number | null;
	avgStabilityDays: number | null;
	practiceSessions: number;
	practiceSolvedCount: number;
	practiceHintsCount: number;
	practiceUnsolvedCount: number;
	practiceSolveRatePct: number | null;
	avgMinutesPerProblem: number | null;
	avgMinutesPerSession: number | null;
	teachSessions: number;
	loggedPlannerMinutes: number;
	paceFactor: number;
}

export interface PlannerLearningProfile {
	sufficientData: boolean;
	sufficiencyReason: string;
	totalFsrsReviews: number;
	totalPracticeSessions: number;
	totalTeachSessions: number;
	loggedStudyDays: number;
	overallRetentionPct: number | null;
	overallSolveRatePct: number | null;
	avgMinutesPerProblem: number | null;
	avgMinutesPerTopic: number | null;
	sustainableDailyHours: number | null;
	realismFactor: number;
	bySubject: Record<string, SubjectLearningMetrics>;
}

export interface PlannerPersonalSignals {
	date: string;
	examPrep: ExamPrepStatus;
	subjectSignals: PlannerSubjectSignal[];
	mistakeHints?: ExamPrepMistakeHints;
	recentSessions: PlannerSessionSummary[];
	autoTrackedStudyMinBySubject?: Record<string, number>;
	learningProfile?: PlannerLearningProfile;
	habitTrend: {
		loggedDays: number;
		avgEnergy: number | null;
		latestBedtime: string | null;
		avgStudyMin: number;
	};
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

export const INTENSITY_STUDY_BOUNDS: Record<PlannerIntensity, {
	utilization: number;
	softCapMin: number;
	minFloorMin: number;
	hardCeilingMin: number;
	minHobbyMin: number;
	maxSubjects: number;
}> = {
	healthy: { utilization: 0.42, softCapMin: 210, minFloorMin: 90, hardCeilingMin: 240, minHobbyMin: 75, maxSubjects: 2 },
	balanced: { utilization: 0.58, softCapMin: 300, minFloorMin: 120, hardCeilingMin: 345, minHobbyMin: 55, maxSubjects: 3 },
	intensive: { utilization: 0.80, softCapMin: 465, minFloorMin: 210, hardCeilingMin: 540, minHobbyMin: 30, maxSubjects: 3 },
};

export const DEFAULT_LIFESTYLE_CONFIG: LifestyleConfig = {
	sleep: {
		currentBedtime: "00:30",
		targetBedtime: "23:15",
		targetSleepHours: 7.5,
		shiftStepMinPerDay: 30,
		peakFocusWindow: "auto",
		earlyWakingIssue: false,
		preferredWakeTime: "07:00",
		windDownBufferMin: 30,
		allowMiddayRecoveryNap: true,
	},
	meals: [
		{ id: "meal_breakfast", label: "Breakfast", startTime: "07:45", durationMin: 30 },
		{ id: "meal_lunch", label: "Lunch + Rest", startTime: "12:00", durationMin: 60 },
		{ id: "meal_dinner", label: "Dinner", startTime: "18:30", durationMin: 45 },
	],
	hobbies: ["Walking / Sport", "Music / Reading"],
	dailyHobbyMin: 60,
	gameBudgetMin: 0,
	gameCutoffBeforeBedMin: 90,
	blockDurationMin: 50,
	breakDurationMin: 10,
	strictSwitchWarning: true,
};

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
	version: 1,
	engineMode: "local",
	intensity: "balanced",
	fixedEvents: [],
	examTimetable: [],
	milestones: [],
	lifestyle: DEFAULT_LIFESTYLE_CONFIG,
	logs: {},
	plans: {},
	dayOverrides: {},
	dismissedExamProfileIds: [],
	updatedAt: "",
};

export function localDateString(now = Date.now()): string {
	const d = new Date(now);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isValidDateString(value: unknown): value is string {
	return typeof value === "string" && DATE_RE.test(value.trim());
}

export function parseClockMin(hhmm: unknown): number | null {
	if (typeof hhmm !== "string") return null;
	const m = CLOCK_RE.exec(hhmm.trim());
	if (!m) return null;
	const hh = Number(m[1]);
	const mm = Number(m[2]);
	return hh * 60 + mm;
}

export function formatClockMin(min: number): string {
	const norm = ((Math.round(min) % 1440) + 1440) % 1440;
	const hh = Math.floor(norm / 60);
	const mm = norm % 60;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function weekdayForDate(dateStr: string): Weekday {
	if (!DATE_RE.test(dateStr)) return "mon";
	const [y, m, d] = dateStr.split("-").map(Number);
	const utcDay = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Sun..6=Sat
	return WEEKDAYS[(utcDay + 6) % 7]!;
}

export function daysBetweenDates(fromDate: string, toDate: string): number {
	const [fy, fm, fd] = fromDate.split("-").map(Number);
	const [ty, tm, td] = toDate.split("-").map(Number);
	const a = Date.UTC(fy!, fm! - 1, fd!);
	const b = Date.UTC(ty!, tm! - 1, td!);
	return Math.round((b - a) / DAY_MS);
}

export function addDaysToDate(dateStr: string, deltaDays: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const dt = new Date(Date.UTC(y!, m! - 1, d! + deltaDays));
	return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Normalize subject names for tolerant matching across milestones, Knowledge Graph clusters,
 * muted/pinned preferences, and freeform daily journal entries.
 */
export function normalizeSubjectKey(subject: string): string {
	return subject
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/đ/g, "d")
		.replace(/Đ/g, "d")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function isSubjectMuted(subject: string, mutedSubjects?: readonly string[]): boolean {
	if (!mutedSubjects || mutedSubjects.length === 0) return false;
	const target = normalizeSubjectKey(subject);
	if (!target) return false;
	return mutedSubjects.some((m) => {
		const mk = normalizeSubjectKey(m);
		return mk === target || (mk.length >= 4 && (target.includes(mk) || mk.includes(target)));
	});
}

export function resolveSubjectMaxDailyCap(config: PlannerConfig): number {
	if (typeof config.dailyMaxSubjects === "number" && Number.isFinite(config.dailyMaxSubjects)) {
		return clamp(Math.round(config.dailyMaxSubjects), 1, 5);
	}
	return INTENSITY_STUDY_BOUNDS[config.intensity].maxSubjects;
}

/**
 * Clip text safely without severing inline `$...$` KaTeX spans or trailing LaTeX backslashes
 * so HostMarkdown renders math cleanly without raw truncated commands.
 */
export function clipPreservingLatex(raw: string, maxLen = 220): string {
	let s = String(raw || "").replace(/\s+/g, " ").trim();
	if (!s) return "";
	s = s.replace(/\\[a-zA-Z]*$/, "").trim();
	const dollarCount = (s.match(/(?<!\\)\$/g) ?? []).length;
	if (dollarCount % 2 === 1) {
		const lastIdx = s.lastIndexOf("$");
		if (lastIdx >= 0) {
			const tail = s.slice(lastIdx + 1).trim();
			// Drop incomplete dangling math block or close valid expression safely
			if (!tail || /\\[a-zA-Z]*$/.test(tail) || tail.includes("{") && !tail.includes("}")) {
				s = s.slice(0, lastIdx).trim();
			} else {
				s = `${s}$`;
			}
		}
	}
	if (s.length <= maxLen) return s;
	const candidate = s.slice(0, maxLen - 1);
	// Avoid slicing inside an open $...$ span
	const candDollars = (candidate.match(/(?<!\\)\$/g) ?? []).length;
	let cutPos = candidate.lastIndexOf(" ");
	if (candDollars % 2 === 1) {
		const openDollar = candidate.lastIndexOf("$");
		if (openDollar > 16) cutPos = openDollar;
	}
	const safe = (cutPos > maxLen * 0.45 ? candidate.slice(0, cutPos) : candidate).trimEnd();
	return `${safe}…`;
}

/**
 * Convert raw inline LaTeX / truncated math fragments into crisp plain Unicode
 * text for compact cards and checklists, clipping cleanly on word boundaries.
 */
export function formatPlainMathPreview(raw: string, maxLen = 180): string {
	let s = String(raw || "").replace(/\s+/g, " ").trim();
	if (!s) return "";
	// Strip broken incomplete trailing LaTeX command left by earlier upstream slicing
	s = s.replace(/\s*\$\s*\\[a-zA-Z]*$/g, "").replace(/\\[a-zA-Z]*$/g, (m) => (m.length <= 4 ? "" : m));
	s = s.replace(/\$\$/g, "").replace(/\$/g, "");
	s = s.replace(/\\(?:left|right|displaystyle|textstyle)\b/g, "");
	// Repeatedly simplify \frac{A}{B}
	for (let i = 0; i < 3; i++) {
		s = s.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)");
	}
	s = s.replace(/\\sqrt\s*\{([^{}]+)\}/g, "√($1)");
	const replacements: ReadonlyArray<[RegExp, string]> = [
		[/\\cdot/g, "·"],
		[/\\times/g, "×"],
		[/\\div/g, "÷"],
		[/\\pm/g, "±"],
		[/\\infty/g, "∞"],
		[/\\leq?/g, "≤"],
		[/\\geq?/g, "≥"],
		[/\\neq?/g, "≠"],
		[/\\approx/g, "≈"],
		[/\\Leftrightarrow|\\iff/g, "⇔"],
		[/\\Rightarrow/g, "⇒"],
		[/\\rightarrow|\\to\b/g, "→"],
		[/\\forall/g, "∀"],
		[/\\exists/g, "∃"],
		[/\\in\b/g, "∈"],
		[/\\notin\b/g, "∉"],
		[/\\subset/g, "⊂"],
		[/\\cup/g, "∪"],
		[/\\cap/g, "∩"],
		[/\\sum/g, "∑"],
		[/\\prod/g, "∏"],
		[/\\int/g, "∫"],
		[/\\partial/g, "∂"],
		[/\\pi/g, "π"],
		[/\\alpha/g, "α"],
		[/\\beta/g, "β"],
		[/\\gamma/g, "γ"],
		[/\\delta/g, "δ"],
		[/\\varepsilon|\\epsilon/g, "ε"],
		[/\\theta/g, "θ"],
		[/\\lambda/g, "λ"],
		[/\\sigma/g, "σ"],
		[/\\omega/g, "ω"],
	];
	for (const [re, glyph] of replacements) {
		s = s.replace(re, glyph);
	}
	s = s
		.replace(/_\{([^{}]+)\}/g, "_($1)")
		.replace(/\^\{([^{}]+)\}/g, "^($1)")
		.replace(/\\([a-zA-Z]+)/g, "$1")
		.replace(/[{}]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (s.length <= maxLen) return s;
	const sliced = s.slice(0, maxLen - 1);
	const wordBoundary = sliced.lastIndexOf(" ");
	return `${(wordBoundary > maxLen * 0.55 ? sliced.slice(0, wordBoundary) : sliced).trimEnd()}…`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function normalizeClockString(raw: unknown, fallback: string): string {
	const parsed = parseClockMin(raw);
	return parsed === null ? fallback : formatClockMin(parsed);
}

function sanitizeStringArray(raw: unknown, maxItems: number, maxLen: number): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim().slice(0, maxLen);
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
		if (out.length >= maxItems) break;
	}
	return out;
}

function slugId(prefix: string, raw: string, idx: number): string {
	const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 28);
	return `${prefix}_${clean || "item"}_${idx}`;
}

function sanitizeFixedEvents(raw: unknown, fallback: readonly FixedWeeklyEvent[] = []): FixedWeeklyEvent[] {
	if (!Array.isArray(raw)) return fallback.map((e) => ({ ...e }));
	const out: FixedWeeklyEvent[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		const dayRaw = typeof obj.dayOfWeek === "string" ? obj.dayOfWeek.trim().toLowerCase() : "";
		if (!(WEEKDAYS as readonly string[]).includes(dayRaw)) continue;
		const startMin = parseClockMin(obj.startTime);
		const endMin = parseClockMin(obj.endTime);
		if (startMin === null || endMin === null || endMin <= startMin) continue;
		const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 80) : "";
		if (!title) continue;
		const id = typeof obj.id === "string" && obj.id.trim()
			? obj.id.trim().slice(0, 64)
			: slugId("fix", `${dayRaw}_${startMin}_${title}`, i);
		if (seen.has(id)) continue;
		seen.add(id);
		const cat = obj.category;
		const category: FixedEventCategory =
			cat === "class" || cat === "club" || cat === "work" || cat === "commute" || cat === "other"
				? cat
				: "class";
		out.push({
			id,
			dayOfWeek: dayRaw as Weekday,
			startTime: formatClockMin(startMin),
			endTime: formatClockMin(endMin),
			title,
			category,
		});
		if (out.length >= 120) break;
	}
	return out;
}

function sanitizeMilestones(raw: unknown, fallback: readonly StudyMilestone[] = []): StudyMilestone[] {
	if (!Array.isArray(raw)) return fallback.map((m) => ({ ...m, clusterIds: [...m.clusterIds], syllabusTopics: m.syllabusTopics.map((t) => ({ ...t })) }));
	const out: StudyMilestone[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 120) : "";
		if (!title) continue;
		const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim().slice(0, 64) : slugId("ms", title, i);
		if (seen.has(id)) continue;
		seen.add(id);
		const kindRaw = obj.kind;
		const kind: MilestoneKind =
			kindRaw === "exam" || kindRaw === "competition" || kindRaw === "project" || kindRaw === "deadline"
				? kindRaw
				: "exam";
		const dueDate = isValidDateString(obj.dueDate) ? obj.dueDate.trim() : addDaysToDate(localDateString(), 14);
		const subject = typeof obj.subject === "string" && obj.subject.trim()
			? obj.subject.trim().slice(0, 80)
			: title;
		const priority = obj.priority === 1 || obj.priority === 2 || obj.priority === 3
			? obj.priority
			: kind === "competition" ? 3 : 2;
		const cognitiveLoad: CognitiveLoad =
			obj.cognitiveLoad === "heavy" || obj.cognitiveLoad === "medium" || obj.cognitiveLoad === "light"
				? obj.cognitiveLoad
				: kind === "competition" ? "heavy" : "medium";
		const estimatedHours = clamp(Number(obj.estimatedHours) || 12, 0.5, 500);
		const completedHours = clamp(Number(obj.completedHours) || 0, 0, estimatedHours);
		const syllabusTopics: SyllabusTopic[] = [];
		if (Array.isArray(obj.syllabusTopics)) {
			for (let j = 0; j < obj.syllabusTopics.length && syllabusTopics.length < 40; j++) {
				const t = obj.syllabusTopics[j] as Record<string, unknown> | undefined;
				if (!t || typeof t !== "object") continue;
				const tTitle = typeof t.title === "string" ? t.title.trim().slice(0, 100) : "";
				if (!tTitle) continue;
				const tid = typeof t.id === "string" && t.id.trim() ? t.id.trim().slice(0, 64) : slugId("top", tTitle, j);
				syllabusTopics.push({
					id: tid,
					title: tTitle,
					estHours: clamp(Number(t.estHours) || 2, 0.25, 100),
					done: Boolean(t.done),
				});
			}
		}
		out.push({
			id,
			kind,
			title,
			subject,
			dueDate,
			priority,
			cognitiveLoad,
			clusterIds: sanitizeStringArray(obj.clusterIds, 24, 64),
			estimatedHours,
			completedHours,
			syllabusTopics,
			notes: typeof obj.notes === "string" ? obj.notes.trim().slice(0, 1500) : "",
			...(typeof obj.sourceSummary === "string" && obj.sourceSummary.trim()
				? { sourceSummary: obj.sourceSummary.trim().slice(0, 600) }
				: {}),
			...(typeof obj.examProfileId === "string" && obj.examProfileId.trim()
				? { examProfileId: obj.examProfileId.trim().slice(0, 64) }
				: {}),
		});
		if (out.length >= 40) break;
	}
	return out;
}

function sanitizeMealSlots(raw: unknown, fallback?: readonly MealSlot[]): MealSlot[] {
	if (!Array.isArray(raw)) return fallback ? fallback.map((m) => ({ ...m })) : [];
	return raw
		.filter((m): m is Record<string, unknown> => Boolean(m && typeof m === "object" && !Array.isArray(m)))
		.slice(0, 6)
		.map((m, idx) => ({
			id: typeof m.id === "string" && m.id.trim() ? m.id.trim().slice(0, 40) : `meal_${idx}`,
			label: typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, 40) : `Meal ${idx + 1}`,
			startTime: normalizeClockString(m.startTime, "12:00"),
			durationMin: clamp(Math.round(Number(m.durationMin) || 40), 15, 120),
		}));
}

function sanitizePlannedBlocks(raw: unknown, dateFallback: string): PlannedBlock[] {
	if (!Array.isArray(raw)) return [];
	const out: PlannedBlock[] = [];
	for (let i = 0; i < raw.length && out.length < 48; i++) {
		const b = raw[i] as Record<string, unknown> | undefined;
		if (!b || typeof b !== "object" || Array.isArray(b)) continue;
		const s = parseClockMin(b.startTime);
		const e = parseClockMin(b.endTime);
		if (s === null) continue;
		let startMin = typeof b.startMin === "number" && Number.isFinite(b.startMin) ? Math.round(b.startMin) : s;
		let endMin = typeof b.endMin === "number" && Number.isFinite(b.endMin)
			? Math.round(b.endMin)
			: e !== null
				? (e <= s ? e + 1440 : e)
				: startMin + clamp(Math.round(Number(b.durationMin) || 45), 5, 360);
		if (endMin <= startMin) {
			if (e !== null && e + 1440 > s) endMin = e + 1440;
			else continue;
		}
		const durationMin = clamp(endMin - startMin, 1, 600);
		endMin = startMin + durationMin;
		const typeRaw = b.type;
		const type: PlannedBlock["type"] =
			typeRaw === "study" || typeRaw === "break" || typeRaw === "hobby" || typeRaw === "meal" || typeRaw === "sleep" || typeRaw === "fixed"
				? typeRaw
				: "study";
		const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 120) : "Study block";
		const subject = typeof b.subject === "string" && b.subject.trim() ? b.subject.trim().slice(0, 80) : undefined;
		const cognitiveLoad: CognitiveLoad | undefined =
			b.cognitiveLoad === "heavy" || b.cognitiveLoad === "medium" || b.cognitiveLoad === "light"
				? b.cognitiveLoad
				: undefined;
		const recallFocus = type === "study" ? sanitizeRecallFocus(b.recallFocus) : undefined;
		out.push({
			id: typeof b.id === "string" && b.id.trim() ? b.id.trim().slice(0, 80) : `blk_custom_${dateFallback}_${i}`,
			date: isValidDateString(b.date) ? b.date : dateFallback,
			startTime: formatClockMin(startMin),
			endTime: formatClockMin(endMin),
			startMin,
			endMin,
			durationMin,
			type,
			title,
			...(subject ? { subject } : {}),
			...(typeof b.milestoneId === "string" && b.milestoneId.trim() ? { milestoneId: b.milestoneId.trim().slice(0, 64) } : {}),
			...(cognitiveLoad ? { cognitiveLoad } : {}),
			...(typeof b.reason === "string" && b.reason.trim() ? { reason: b.reason.trim().slice(0, 140) } : {}),
			...(typeof b.strictSwitch === "boolean" ? { strictSwitch: b.strictSwitch } : {}),
			...(typeof b.actionTopic === "string" && b.actionTopic.trim() ? { actionTopic: b.actionTopic.trim().slice(0, 140) } : {}),
			...(recallFocus && recallFocus.minutes * 3 <= durationMin ? { recallFocus } : {}),
		});
	}
	return out.sort((a, b) => a.startMin - b.startMin);
}

function sanitizeActualEntries(raw: unknown, dateFallback: string): JournalActivityEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: JournalActivityEntry[] = [];
	for (let i = 0; i < raw.length && out.length < 64; i++) {
		const r = raw[i] as Record<string, unknown> | undefined;
		if (!r || typeof r !== "object" || Array.isArray(r)) continue;
		const s = parseClockMin(r.startTime);
		const e = parseClockMin(r.endTime);
		const startMin = s ?? 8 * 60;
		const minutesRaw = Number(r.minutes);
		const minutes = Number.isFinite(minutesRaw) && minutesRaw > 0
			? clamp(Math.round(minutesRaw), 1, 720)
			: e !== null
				? clamp(e > startMin ? e - startMin : e + 1440 - startMin, 1, 720)
				: 30;
		const endMin = e !== null ? (e > startMin ? e : e + 1440) : startMin + minutes;
		const cat = r.category;
		const category: JournalActivityCategory =
			cat === "study" || cat === "class" || cat === "sleep" || cat === "meal" || cat === "hobby" || cat === "rest" || cat === "distraction" || cat === "other"
				? cat
				: "other";
		const title = typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 140) : "Logged activity";
		const src = r.source === "manual" || r.source === "ai_extracted" ? r.source : "parsed_text";
		out.push({
			id: typeof r.id === "string" && r.id.trim() ? r.id.trim().slice(0, 64) : `j_${dateFallback}_${i}`,
			startTime: formatClockMin(startMin),
			endTime: formatClockMin(endMin),
			category,
			...(typeof r.subject === "string" && r.subject.trim() ? { subject: r.subject.trim().slice(0, 80) } : {}),
			title,
			minutes,
			source: src,
		});
	}
	return out;
}

function sanitizeComplianceReport(raw: unknown, dateFallback: string): PlanComplianceReport | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.summary !== "string" || !r.summary.trim()) return undefined;
	const plannedStudyMin = clamp(Math.round(Number(r.plannedStudyMin) || 0), 0, 960);
	const actualStudyMin = clamp(Math.round(Number(r.actualStudyMin) || 0), 0, 960);
	return {
		date: isValidDateString(r.date) ? r.date : dateFallback,
		evaluatedAt: typeof r.evaluatedAt === "string" ? r.evaluatedAt : new Date().toISOString(),
		evaluatedBy: r.evaluatedBy === "llm" ? "llm" : "local",
		...(typeof r.modelLabel === "string" && r.modelLabel.trim() ? { modelLabel: r.modelLabel.trim().slice(0, 120) } : {}),
		...(r.numericMismatch === true ? { numericMismatch: true } : {}),
		adherencePct: clamp(Math.round(Number(r.adherencePct) || 0), 0, 100),
		scorable: typeof r.scorable === "boolean" ? r.scorable : plannedStudyMin > 0,
		plannedStudyMin,
		actualStudyMin,
		realismRatio: clamp(Math.round((Number(r.realismRatio) || 1) * 100) / 100, 0.35, 1.45),
		summary: r.summary.trim().slice(0, 600),
		strengths: sanitizeStringArray(r.strengths, 6, 180),
		frictionPoints: sanitizeStringArray(r.frictionPoints, 6, 180),
		nextDayAdvice: typeof r.nextDayAdvice === "string" ? r.nextDayAdvice.trim().slice(0, 260) : "",
	};
}

function sanitizeLifestyle(raw: unknown, fallback: LifestyleConfig = DEFAULT_LIFESTYLE_CONFIG): LifestyleConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			...fallback,
			sleep: { ...fallback.sleep },
			meals: fallback.meals.map((m) => ({ ...m })),
			hobbies: [...fallback.hobbies],
		};
	}
	const obj = raw as Record<string, unknown>;
	const rawSleep = (obj.sleep && typeof obj.sleep === "object" ? obj.sleep : {}) as Record<string, unknown>;
	const peak = rawSleep.peakFocusWindow;
	const peakFocusWindow: PeakFocusWindow =
		peak === "auto" || peak === "morning" || peak === "afternoon" || peak === "evening"
			? peak
			: fallback.sleep.peakFocusWindow;
	const sleep: SleepRecoveryProfile = {
		currentBedtime: normalizeClockString(rawSleep.currentBedtime, fallback.sleep.currentBedtime),
		targetBedtime: normalizeClockString(rawSleep.targetBedtime, fallback.sleep.targetBedtime),
		targetSleepHours: clamp(Number(rawSleep.targetSleepHours) || fallback.sleep.targetSleepHours, 5, 10),
		shiftStepMinPerDay: clamp(Math.round(Number(rawSleep.shiftStepMinPerDay) || fallback.sleep.shiftStepMinPerDay), 10, 90),
		peakFocusWindow,
		...(typeof rawSleep.earlyWakingIssue === "boolean" ? { earlyWakingIssue: rawSleep.earlyWakingIssue } : {}),
		...(parseClockMin(rawSleep.preferredWakeTime) !== null
			? { preferredWakeTime: normalizeClockString(rawSleep.preferredWakeTime, "07:00") }
			: {}),
		...(typeof rawSleep.windDownBufferMin === "number" && Number.isFinite(rawSleep.windDownBufferMin)
			? { windDownBufferMin: clamp(Math.round(rawSleep.windDownBufferMin), 15, 60) }
			: {}),
		...(typeof rawSleep.allowMiddayRecoveryNap === "boolean"
			? { allowMiddayRecoveryNap: rawSleep.allowMiddayRecoveryNap }
			: {}),
		...(typeof rawSleep.postDinnerComaProtection === "boolean"
			? { postDinnerComaProtection: rawSleep.postDinnerComaProtection }
			: {}),
		...(parseClockMin(rawSleep.eveningDrowsyStart) !== null
			? { eveningDrowsyStart: normalizeClockString(rawSleep.eveningDrowsyStart, "20:00") }
			: {}),
	};

	const meals: MealSlot[] = sanitizeMealSlots(obj.meals, fallback.meals);

	const hobbies = Array.isArray(obj.hobbies)
		? sanitizeStringArray(obj.hobbies, 12, 60)
		: [...fallback.hobbies];
	const hobbyPreferences: NonNullable<LifestyleConfig["hobbyPreferences"]> = {};
	const prefs = obj.hobbyPreferences && typeof obj.hobbyPreferences === "object" && !Array.isArray(obj.hobbyPreferences) ? obj.hobbyPreferences as Record<string, unknown> : {};
	for (const hobby of hobbies) {
		const pref = prefs[hobby];
		if (!pref || typeof pref !== "object" || Array.isArray(pref)) continue;
		const value = pref as Record<string, unknown>;
		if (typeof value.dailyMin !== "number" || !Number.isFinite(value.dailyMin)) continue;
		const window = value.preferredWindow;
		hobbyPreferences[hobby] = { dailyMin: clamp(Math.round(value.dailyMin), 0, 240), preferredWindow: window === "morning" || window === "afternoon" || window === "evening" ? window : "auto" };
	}

	const rawGuard = obj.wellnessGuardrail as Record<string, unknown> | undefined;
	const wellnessGuardrail: WellnessGuardrailConfig | undefined =
		rawGuard && typeof rawGuard === "object" && !Array.isArray(rawGuard)
			? {
				enabled: Boolean(rawGuard.enabled),
				...(typeof rawGuard.currentWeeklyFreq === "number" && Number.isFinite(rawGuard.currentWeeklyFreq)
					? { currentWeeklyFreq: clamp(Math.round(rawGuard.currentWeeklyFreq), 0, 30) }
					: {}),
				...(typeof rawGuard.targetWeeklyFreq === "number" && Number.isFinite(rawGuard.targetWeeklyFreq)
					? { targetWeeklyFreq: clamp(Math.round(rawGuard.targetWeeklyFreq), 0, 21) }
					: {}),
				riskWindows: sanitizeStringArray(rawGuard.riskWindows, 12, 40),
				...(typeof rawGuard.replacementProtocol === "string" && rawGuard.replacementProtocol.trim()
					? { replacementProtocol: rawGuard.replacementProtocol.trim().slice(0, 220) }
					: {}),
				...(typeof rawGuard.wakeUpAnchorProtocol === "string" && rawGuard.wakeUpAnchorProtocol.trim()
					? { wakeUpAnchorProtocol: rawGuard.wakeUpAnchorProtocol.trim().slice(0, 220) }
					: {}),
				...(typeof rawGuard.cravingReframeNote === "string" && rawGuard.cravingReframeNote.trim()
					? { cravingReframeNote: rawGuard.cravingReframeNote.trim().slice(0, 280) }
					: {}),
				...(Array.isArray(rawGuard.deviceFrictionRules)
					? { deviceFrictionRules: sanitizeStringArray(rawGuard.deviceFrictionRules, 8, 90) }
					: {}),
			}
			: undefined;

	return {
		sleep,
		meals,
		hobbies,
		...(Object.keys(hobbyPreferences).length ? { hobbyPreferences } : {}),
		dailyHobbyMin: clamp(Math.round(Number(obj.dailyHobbyMin ?? fallback.dailyHobbyMin)), 0, 240),
		...(typeof obj.gameBudgetMin === "number" && Number.isFinite(obj.gameBudgetMin)
			? { gameBudgetMin: clamp(Math.round(obj.gameBudgetMin), 0, 180) }
			: {}),
		...(typeof obj.gameCutoffBeforeBedMin === "number" && Number.isFinite(obj.gameCutoffBeforeBedMin)
			? { gameCutoffBeforeBedMin: clamp(Math.round(obj.gameCutoffBeforeBedMin), 30, 240) }
			: {}),
		...(wellnessGuardrail ? { wellnessGuardrail } : {}),
		blockDurationMin: clamp(Math.round(Number(obj.blockDurationMin ?? fallback.blockDurationMin)), 25, 120),
		breakDurationMin: clamp(Math.round(Number(obj.breakDurationMin ?? fallback.breakDurationMin)), 5, 30),
		strictSwitchWarning: typeof obj.strictSwitchWarning === "boolean" ? obj.strictSwitchWarning : fallback.strictSwitchWarning,
	};
}

function sanitizeLogs(raw: unknown): Record<string, DailyHabitLog> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const entries = Object.entries(raw as Record<string, unknown>)
		.filter(([date]) => DATE_RE.test(date))
		.sort(([a], [b]) => b.localeCompare(a));
	const out: Record<string, DailyHabitLog> = {};
	for (const [date, val] of entries) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const v = val as Record<string, unknown>;
		const energy = v.energyScore === 1 || v.energyScore === 2 || v.energyScore === 3 || v.energyScore === 4 || v.energyScore === 5
			? v.energyScore
			: undefined;
		const sleepQuality = v.sleepQuality === 1 || v.sleepQuality === 2 || v.sleepQuality === 3 || v.sleepQuality === 4 || v.sleepQuality === 5
			? v.sleepQuality
			: undefined;
		const loggedStudyMinBySubject: Record<string, number> = {};
		if (v.loggedStudyMinBySubject && typeof v.loggedStudyMinBySubject === "object" && !Array.isArray(v.loggedStudyMinBySubject)) {
			for (const [sub, min] of Object.entries(v.loggedStudyMinBySubject as Record<string, unknown>)) {
				if (typeof sub === "string" && sub.trim()) {
					loggedStudyMinBySubject[sub.trim().slice(0, 80)] = clamp(Math.round(Number(min) || 0), 0, 1440);
				}
			}
		}
		const actualEntries = sanitizeActualEntries(v.actualEntries, date);
		const habitCounts = Array.isArray(v.habitCounts) ? v.habitCounts.flatMap((raw) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
			const item = raw as Record<string, unknown>;
			if (typeof item.id !== "string" || typeof item.name !== "string" || !item.id.trim() || !item.name.trim() || typeof item.count !== "number" || !Number.isInteger(item.count) || item.count < 0 || item.count > 1000) return [];
			return [{ id: item.id.trim().slice(0, 80), name: item.name.trim().slice(0, 120), count: item.count }];
		}).slice(0, 100) : [];
		const compliance = sanitizeComplianceReport(v.compliance, date);
		out[date] = {
			date,
			...(parseClockMin(v.actualBedtime) !== null ? { actualBedtime: normalizeClockString(v.actualBedtime, "23:30") } : {}),
			...(parseClockMin(v.actualWakeTime) !== null ? { actualWakeTime: normalizeClockString(v.actualWakeTime, "07:00") } : {}),
			...(sleepQuality ? { sleepQuality } : {}),
			...(typeof v.wokeEarlyUnintended === "boolean" ? { wokeEarlyUnintended: v.wokeEarlyUnintended } : {}),
			...(energy ? { energyScore: energy } : {}),
			...(typeof v.foodComaHitToday === "boolean" ? { foodComaHitToday: v.foodComaHitToday } : {}),
			...(typeof v.urgesSurfed === "number" && Number.isFinite(v.urgesSurfed) && v.urgesSurfed >= 0
				? { urgesSurfed: clamp(Math.round(v.urgesSurfed), 0, 100) }
				: {}),
			...(Array.isArray(v.urgeTriggerWindows)
				? { urgeTriggerWindows: sanitizeStringArray(v.urgeTriggerWindows, 12, 40) }
				: {}),
			completedBlockIds: sanitizeStringArray(v.completedBlockIds, 60, 80),
			completedChecklistIds: sanitizeStringArray(v.completedChecklistIds, 120, 80),
			loggedStudyMinBySubject,
			hobbyDone: Boolean(v.hobbyDone),
			mealsOk: typeof v.mealsOk === "boolean" ? v.mealsOk : false,
			...(typeof v.sleepOnTarget === "boolean" ? { sleepOnTarget: v.sleepOnTarget } : {}),
			...(typeof v.note === "string" && v.note.trim() ? { note: v.note.trim().slice(0, 4000) } : {}),
			...(typeof v.journalText === "string" && v.journalText.trim() ? { journalText: v.journalText.trim().slice(0, 4000) } : {}),
			...(actualEntries.length > 0 ? { actualEntries } : {}),
			...(habitCounts.length > 0 ? { habitCounts } : {}),
			...(compliance ? { compliance } : {}),
			...(typeof v.updatedAt === "string" ? { updatedAt: v.updatedAt } : {}),
		};
	}
	return out;
}

function sanitizePlans(raw: unknown): Record<string, DailyStudyPlan> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const entries = Object.entries(raw as Record<string, unknown>)
		.filter(([date]) => DATE_RE.test(date))
		.sort(([a], [b]) => b.localeCompare(a))
		.slice(0, 90);
	const out: Record<string, DailyStudyPlan> = {};
	for (const [date, val] of entries) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const p = val as Record<string, unknown>;
		if (!Array.isArray(p.blocks) || !Array.isArray(p.quotas)) continue;
		out[date] = p as unknown as DailyStudyPlan;
	}
	return out;
}

function sanitizePlanHistory(raw: unknown): NonNullable<PlannerConfig["planHistory"]> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: NonNullable<PlannerConfig["planHistory"]> = {};
	for (const [date, records] of Object.entries(raw)) {
		if (!DATE_RE.test(date) || !Array.isArray(records)) continue;
		const valid = records.flatMap((record) => {
			if (!record || typeof record !== "object" || Array.isArray(record)) return [];
			const item = record as { replacedAt?: unknown; plan?: unknown };
			if (typeof item.replacedAt !== "string" || !Number.isFinite(Date.parse(item.replacedAt))) return [];
			const plan = sanitizePlans({ [date]: item.plan })[date];
			return plan ? [{ replacedAt: item.replacedAt, plan }] : [];
		});
		if (valid.length) out[date] = valid;
	}
	return out;
}

/** Preserve prior plans without inventing records for dates whose plan was never saved. */
export function archivePlannerPlan(config: PlannerConfig, date: string, now: number): PlannerConfig {
	const plan = config.plans[date];
	if (!plan || localDateString(now) !== date || !Number.isFinite(Date.parse(plan.generatedAt)) || Date.parse(plan.generatedAt) > now) return config;
	const versions = config.planHistory?.[date] ?? [];
	if (versions.some((entry) => entry.plan.generatedAt === plan.generatedAt && JSON.stringify(entry.plan.blocks) === JSON.stringify(plan.blocks))) return config;
	return { ...config, planHistory: { ...config.planHistory, [date]: [...versions, { replacedAt: new Date(now).toISOString(), plan: structuredClone(plan) }] } };
}

/** Past versions contribute only blocks that ended while that version was active. */
export function studyBlocksForAudit(config: PlannerConfig, date: string, plan?: DailyStudyPlan): PlannedBlock[] {
	const history = (config.planHistory?.[date] ?? []).flatMap(({ plan: prior, replacedAt }) => {
		const generated = Date.parse(prior.generatedAt), replaced = Date.parse(replacedAt);
		if (!Number.isFinite(generated) || !Number.isFinite(replaced) || replaced < generated) return [];
		const startDate = localDateString(generated), endDate = localDateString(replaced);
		if (startDate > date || endDate < date) return [];
		const start = startDate < date ? 0 : new Date(generated).getHours() * 60 + new Date(generated).getMinutes();
		const end = endDate > date ? 1440 : new Date(replaced).getHours() * 60 + new Date(replaced).getMinutes();
		return prior.blocks.filter((block) => block.type === "study" && block.startMin >= start && block.endMin <= end);
	});
	const result: PlannedBlock[] = [], seen = new Set<string>();
	for (const block of [...history, ...(plan?.blocks ?? []).filter((item) => item.type === "study")]) {
		const key = `${block.startMin}:${block.endMin}:${block.subject ?? ""}`;
		if (!seen.has(key)) { seen.add(key); result.push(block); }
	}
	return result;
}

function sanitizeDayOverrides(raw: unknown): Record<string, DayOverride> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, DayOverride> = {};
	const entries = Object.entries(raw as Record<string, unknown>)
		.filter(([date]) => DATE_RE.test(date))
		.sort(([a], [b]) => b.localeCompare(a))
		.slice(0, 180);
	for (const [date, val] of entries) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const obj = val as Record<string, unknown>;
		const extraBusyEvents: DayOneOffEvent[] = [];
		if (Array.isArray(obj.extraBusyEvents)) {
			for (let i = 0; i < obj.extraBusyEvents.length && extraBusyEvents.length < 24; i++) {
				const rawEv = obj.extraBusyEvents[i] as Record<string, unknown> | undefined;
				if (!rawEv || typeof rawEv !== "object") continue;
				const s = parseClockMin(rawEv.startTime);
				const e = parseClockMin(rawEv.endTime);
				const title = typeof rawEv.title === "string" ? rawEv.title.trim().slice(0, 80) : "";
				if (s === null || e === null || e <= s || !title) continue;
				const cat = rawEv.category;
				const category: FixedEventCategory =
					cat === "class" || cat === "club" || cat === "work" || cat === "commute" || cat === "other"
						? cat
						: "other";
				extraBusyEvents.push({
					id: typeof rawEv.id === "string" && rawEv.id.trim() ? rawEv.id.trim().slice(0, 64) : `ov_${date}_${i}`,
					startTime: formatClockMin(s),
					endTime: formatClockMin(e),
					title,
					category,
				});
			}
		}
		const skipFixedEvents = Boolean(obj.skipFixedEvents);
		const note = typeof obj.note === "string" && obj.note.trim() ? obj.note.trim().slice(0, 400) : undefined;
		const hasTarget = typeof obj.studyTargetHoursOverride === "number" && Number.isFinite(obj.studyTargetHoursOverride);
		const studyTargetHoursOverride = hasTarget
			? clamp(Math.round(Number(obj.studyTargetHoursOverride) * 10) / 10, 0, 14)
			: undefined;
		const wakeTime = parseClockMin(obj.wakeTime) !== null ? normalizeClockString(obj.wakeTime, "07:00") : undefined;
		const bedTime = parseClockMin(obj.bedTime) !== null ? normalizeClockString(obj.bedTime, "23:30") : undefined;
		const meals = Array.isArray(obj.meals) ? sanitizeMealSlots(obj.meals) : undefined;
		const focusSubjects = sanitizeStringArray(obj.focusSubjects, 8, 80);
		const customBlocks = sanitizePlannedBlocks(obj.customBlocks, date);
		if (
			!skipFixedEvents &&
			extraBusyEvents.length === 0 &&
			!note &&
			studyTargetHoursOverride === undefined &&
			!wakeTime &&
			!bedTime &&
			(!meals || meals.length === 0) &&
			focusSubjects.length === 0 &&
			!Array.isArray(obj.customBlocks)
		) {
			continue;
		}
		out[date] = {
			date,
			...(skipFixedEvents ? { skipFixedEvents } : {}),
			...(extraBusyEvents.length > 0 ? { extraBusyEvents } : {}),
			...(note ? { note } : {}),
			...(studyTargetHoursOverride !== undefined ? { studyTargetHoursOverride } : {}),
			...(wakeTime ? { wakeTime } : {}),
			...(bedTime ? { bedTime } : {}),
			...(meals && meals.length > 0 ? { meals } : {}),
			...(focusSubjects.length > 0 ? { focusSubjects } : {}),
			...(Array.isArray(obj.customBlocks) ? { customBlocks } : {}),
		};
	}
	return out;
}

function sanitizeExamTimetable(raw: unknown): ExamTimetableEntry[] {
 if (!Array.isArray(raw)) return [];
 const out: ExamTimetableEntry[] = [];
 const ids = new Set<string>();
 for (const item of raw.slice(0, 500)) {
  if (!item || typeof item !== "object" || Array.isArray(item)) continue;
  const obj = item as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim().slice(0, 80) : "";
  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 160) : "";
  if (!id || !title || ids.has(id)) continue;
  const entry: ExamTimetableEntry = { id, title };
  if (typeof obj.date === "string" && isValidDateString(obj.date)) entry.date = obj.date;
  if (parseClockMin(obj.startTime) !== null) entry.startTime = formatClockMin(parseClockMin(obj.startTime)!);
  if (parseClockMin(obj.endTime) !== null && entry.startTime && parseClockMin(obj.endTime)! > parseClockMin(entry.startTime)!) entry.endTime = formatClockMin(parseClockMin(obj.endTime)!);
  for (const key of ["location", "courseCode", "examType", "format", "session", "seat", "notes"] as const) {
   if (typeof obj[key] === "string" && obj[key].trim()) entry[key] = obj[key].trim().slice(0, key === "notes" ? 500 : 120);
  }
  out.push(entry); ids.add(id);
 }
 return out;
}

function sanitizeCoachChat(raw: unknown): CoachChatMessage[] {
	if (!Array.isArray(raw)) return [];
	const out: CoachChatMessage[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i] as Record<string, unknown> | undefined;
		if (!item || typeof item !== "object") continue;
		const role = item.role === "user" || item.role === "assistant" ? item.role : null;
		const text = typeof item.text === "string" ? item.text.trim().slice(0, 4000) : "";
		if (!role || !text) continue;
		const attachments = Array.isArray(item.attachments) ? item.attachments.flatMap((raw) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
			const a = raw as Record<string, unknown>;
			if (typeof a.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(a.id) || typeof a.name !== "string" || typeof a.mimeType !== "string" || typeof a.size !== "number" || !Number.isFinite(a.size) || a.size < 0) return [];
			return [{ id: a.id, name: a.name.slice(0, 255), mimeType: a.mimeType.slice(0, 100), size: a.size }];
		}).slice(0, 8) : [];
		const focusArea =
			item.focusArea === "schedule" || item.focusArea === "lifestyle" || item.focusArea === "general"
				? item.focusArea
				: undefined;
		let appliedChange: CoachChatAppliedChange | undefined;
		if (item.appliedChange && typeof item.appliedChange === "object" && !Array.isArray(item.appliedChange)) {
			const ac = item.appliedChange as Record<string, unknown>;
			const summary = typeof ac.summary === "string" ? ac.summary.trim().slice(0, 400) : "";
			if (summary) {
				appliedChange = {
					id: typeof ac.id === "string" && ac.id.trim() ? ac.id.trim().slice(0, 64) : `chg_${i}`,
					summary,
					patchLabels: sanitizeStringArray(ac.patchLabels, 12, 80),
					...(ac.reverted ? { reverted: true } : {}),
				};
			}
		}
		out.push({
			id: typeof item.id === "string" && item.id.trim() ? item.id.trim().slice(0, 64) : `cm_${i}`,
			role,
			text,
			timestamp: typeof item.timestamp === "string" ? item.timestamp : "",
			...(attachments.length ? { attachments } : {}),
			...(focusArea ? { focusArea } : {}),
			...(typeof item.modelLabel === "string" && item.modelLabel.trim() ? { modelLabel: item.modelLabel.trim().slice(0, 80) } : {}),
			...(appliedChange ? { appliedChange } : {}),
			...(typeof item.error === "string" && item.error.trim() ? { error: item.error.trim().slice(0, 240) } : {}),
		});
	}
	return out;
}

function sanitizeCoachUndo(raw: unknown): CoachUndoSnapshot | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const messageId = typeof obj.messageId === "string" ? obj.messageId.trim().slice(0, 64) : "";
	const date = typeof obj.date === "string" && DATE_RE.test(obj.date) ? obj.date : "";
	if (!messageId || !date) return undefined;
	const prevIntensity: PlannerIntensity =
		obj.prevIntensity === "healthy" || obj.prevIntensity === "intensive" || obj.prevIntensity === "balanced"
			? obj.prevIntensity
			: "balanced";
	const dayMap = obj.prevDayOverride ? sanitizeDayOverrides({ [date]: obj.prevDayOverride }) : {};
	const logMap = obj.prevLog ? sanitizeLogs({ [date]: obj.prevLog }) : {};
	const plannerSnapshot = (value: unknown): PlannerConfig | undefined => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return sanitizePlannerConfig({ ...(value as Record<string, unknown>), lastCoachUndo: undefined, coachChat: undefined, updatedAt: "" });
	};
	const beforePlanner = plannerSnapshot(obj.beforePlanner);
	const afterPlanner = plannerSnapshot(obj.afterPlanner);
	const sessionChanges = Array.isArray(obj.sessionChanges) ? obj.sessionChanges.flatMap((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
		const item = raw as Record<string, unknown>;
		const meta = (value: unknown): CoachSessionMetadata | null => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return null;
			const m = value as Record<string, unknown>;
			return typeof m.title === "string" && typeof m.notes === "string" && typeof m.pinned === "boolean" && typeof m.archived === "boolean" ? { title: m.title, notes: m.notes, pinned: m.pinned, archived: m.archived } : null;
		};
		const before = meta(item.before), after = meta(item.after);
		return typeof item.id === "string" && item.id && before && after ? [{ id: item.id.slice(0, 120), before, after }] : [];
	}).slice(0, 20) : [];
	const graphChanges = Array.isArray(obj.graphChanges) ? obj.graphChanges.flatMap((raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
		const item = raw as Record<string, unknown>, before = item.before as Record<string, unknown> | null, after = item.after as Record<string, unknown> | null;
		if (typeof item.id !== "string" || !before || !after || typeof before.name !== "string" || typeof before.statement !== "string" || typeof after.name !== "string" || typeof after.statement !== "string" || typeof item.beforeHash !== "string" || typeof item.afterHash !== "string" || !/^[a-f0-9]{64}$/.test(item.beforeHash) || !/^[a-f0-9]{64}$/.test(item.afterHash)) return [];
		return [{ id: item.id, before: { name: before.name, statement: before.statement }, after: { name: after.name, statement: after.statement }, beforeHash: item.beforeHash, afterHash: item.afterHash }];
	}).slice(0, 20) : [];
	const settingsRecord = (value: unknown): import("./settings.ts").UserSettings | undefined => value && typeof value === "object" && !Array.isArray(value) && typeof (value as { version?: unknown }).version === "number" ? value as import("./settings.ts").UserSettings : undefined;
	const beforeSettings = settingsRecord(obj.beforeSettings), afterSettings = settingsRecord(obj.afterSettings);
	return {
		messageId,
		date,
		...(dayMap[date] ? { prevDayOverride: dayMap[date] } : {}),
		hadDayOverride: Boolean(obj.hadDayOverride),
		prevLifestyle: sanitizeLifestyle(obj.prevLifestyle),
		prevIntensity,
		...(logMap[date] ? { prevLog: logMap[date] } : {}),
		hadLog: Boolean(obj.hadLog),
		...(Array.isArray(obj.prevMutedSubjects) ? { prevMutedSubjects: sanitizeStringArray(obj.prevMutedSubjects, 40, 80) } : {}),
		...(Array.isArray(obj.prevPinnedSubjects) ? { prevPinnedSubjects: sanitizeStringArray(obj.prevPinnedSubjects, 40, 80) } : {}),
		...(beforePlanner && afterPlanner ? { beforePlanner, afterPlanner } : {}),
		...(obj.beforeExam && obj.afterExam ? { beforeExam: obj.beforeExam as CoachUndoSnapshot["beforeExam"], afterExam: obj.afterExam as CoachUndoSnapshot["afterExam"] } : {}),
		...(sessionChanges.length ? { sessionChanges } : {}),
		...(graphChanges.length ? { graphChanges } : {}),
		...(beforeSettings && afterSettings ? { beforeSettings, afterSettings } : {}),
	};
}

function sanitizeRecallFocus(value: unknown): RecallWorkloadFocus | undefined {
	if (!value || typeof value !== "object") return undefined;
	const { topic, minutes, mode, task } = value as Partial<RecallWorkloadFocus>;
	if (typeof topic !== "string" || !topic.trim() || typeof minutes !== "number" || ![5, 10, 15].includes(minutes) ||
		(mode !== "recheck" && mode !== "practice")) return undefined;
	return { topic: topic.trim().slice(0, 160), minutes, mode, ...(typeof task === "string" && task.trim() ? { task: task.trim().slice(0, 250) } : {}) };
}

function sanitizeCapacityUndo(value: unknown): CapacityCalibrationUndo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Partial<CapacityCalibrationUndo>;
	if (typeof entry.id !== "string" || !isValidDateString(entry.date) || !Array.isArray(entry.blocks)) return undefined;
	const blocks = entry.blocks.slice(0, 50).flatMap((block) => {
		const after = sanitizeRecallFocus(block?.after);
		if (!after || typeof block?.id !== "string" || typeof block.revision !== "string") return [];
		return [{ id: block.id, date: isValidDateString(block.date) ? block.date : entry.date!, revision: block.revision, before: sanitizeRecallFocus(block.before), after }];
	});
	const realism = entry.realism;
	const validFactor = (factor: unknown): factor is number => typeof factor === "number" && factor >= 0.65 && factor <= 1.25;
	return { id: entry.id, date: entry.date, blocks,
		...(realism && (realism.before === null || validFactor(realism.before)) && validFactor(realism.after) ? { realism } : {}) };
}

export function sanitizePlannerConfig(raw: unknown, fallback: PlannerConfig = DEFAULT_PLANNER_CONFIG): PlannerConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			...fallback,
			fixedEvents: [...fallback.fixedEvents],
			examTimetable: [...(fallback.examTimetable ?? [])],
			milestones: [...fallback.milestones],
			lifestyle: sanitizeLifestyle(fallback.lifestyle),
			logs: {},
			plans: {},
			dayOverrides: {},
			dismissedExamProfileIds: [],
			mutedSubjects: [],
			pinnedSubjects: [],
			coachChat: [],
		};
	}
	const obj = raw as Record<string, unknown>;
	const engineMode: PlannerEngineMode = obj.engineMode === "llm" ? "llm" : "local";
	const intensity: PlannerIntensity =
		obj.intensity === "healthy" || obj.intensity === "intensive" || obj.intensity === "balanced"
			? obj.intensity
			: fallback.intensity;
	const dailyMaxSubjects =
		typeof obj.dailyMaxSubjects === "number" && Number.isFinite(obj.dailyMaxSubjects)
			? clamp(Math.round(obj.dailyMaxSubjects), 1, 5)
			: undefined;
	const realismFactor =
		typeof obj.realismFactor === "number" && Number.isFinite(obj.realismFactor)
			? clamp(Math.round(Number(obj.realismFactor) * 100) / 100, 0.65, 1.25)
			: undefined;
	const coachChat = sanitizeCoachChat(obj.coachChat);
	const lastCoachUndo = sanitizeCoachUndo(obj.lastCoachUndo);
	const lastCapacityCalibration = sanitizeCapacityUndo(obj.lastCapacityCalibration);
	return {
		version: 1,
		engineMode,
		intensity,
		fixedEvents: sanitizeFixedEvents(obj.fixedEvents, fallback.fixedEvents),
		examTimetable: sanitizeExamTimetable(obj.examTimetable),
		milestones: sanitizeMilestones(obj.milestones, fallback.milestones),
		lifestyle: sanitizeLifestyle(obj.lifestyle, fallback.lifestyle),
		logs: sanitizeLogs(obj.logs),
		plans: sanitizePlans(obj.plans),
		planHistory: sanitizePlanHistory(obj.planHistory),
		dayOverrides: sanitizeDayOverrides(obj.dayOverrides),
		dismissedExamProfileIds: sanitizeStringArray(obj.dismissedExamProfileIds, 60, 64),
		mutedSubjects: sanitizeStringArray(obj.mutedSubjects, 40, 80),
		pinnedSubjects: sanitizeStringArray(obj.pinnedSubjects, 40, 80),
		...(dailyMaxSubjects !== undefined ? { dailyMaxSubjects } : {}),
		...(realismFactor !== undefined ? { realismFactor } : {}),
		...(coachChat.length > 0 ? { coachChat } : {}),
		...(lastCoachUndo ? { lastCoachUndo } : {}),
		...(lastCapacityCalibration ? { lastCapacityCalibration } : {}),
		updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : fallback.updatedAt,
	};
}

// ─── Sleep Anchor Recovery ───────────────────────────────────────────────────

/** Map bedtime onto a continuous evening-to-morning axis (>= 15:00 -> 900..2339). */
export function normalizeBedtimeMin(hhmm: string): number {
	const raw = parseClockMin(hhmm) ?? 23 * 60 + 30;
	return raw < 15 * 60 ? raw + 1440 : raw;
}

/** Recognize a single explicit clock marker, never a duration or a time range. */
function journalSleepMarkers(text: string | undefined, kind: "bed" | "wake"): string[] {
	if (!text) return [];
	const times: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^\s*(\d{1,2})(?::|h)(\d{1,2})?\s*:?\s*(.+)$/i);
		if (!match) continue;
		const minutes = Number(match[1]) * 60 + Number(match[2] ?? 0);
		if (Number(match[1]) > 23 || Number(match[2] ?? 0) > 59) continue;
		const textNorm = normalizeSubjectKey(match[3]!);
		if (kind === "bed" ? /^(?:di )?(?:ngu|sleep|bedtime)(?:\s|$)/.test(textNorm) : /^(?:thuc day|day|wake(?: up)?)(?:\s|$)/.test(textNorm)) times.push(formatClockMin(minutes));
	}
	return [...new Set(times)];
}

/** Bedtime belongs to the night starting on date; early clocks belong to its next morning. */
export function journalBedtimeForNight(logs: Record<string, DailyHabitLog>, date: string): { time: string; source: "check-in" | "journal" } | null {
	const explicit = logs[date]?.actualBedtime;
	if (explicit && parseClockMin(explicit) !== null) return { time: explicit, source: "check-in" };
	const evening = journalSleepMarkers(logs[date]?.journalText, "bed").filter((time) => (parseClockMin(time) ?? 0) >= 15 * 60);
	const morning = journalSleepMarkers(logs[addDaysToDate(date, 1)]?.journalText, "bed").filter((time) => (parseClockMin(time) ?? 1440) < 15 * 60);
	const candidates = [...new Set([...evening, ...morning])];
	return candidates.length === 1 ? { time: candidates[0]!, source: "journal" } : null;
}

export function journalWakeForDate(logs: Record<string, DailyHabitLog>, date: string): { time: string; source: "check-in" | "journal" } | null {
	const explicit = logs[date]?.actualWakeTime;
	if (explicit && parseClockMin(explicit) !== null) return { time: explicit, source: "check-in" };
	const candidates = journalSleepMarkers(logs[date]?.journalText, "wake");
	return candidates.length === 1 ? { time: candidates[0]!, source: "journal" } : null;
}

export interface SleepScheduleCalc {
	todayWakeMin: number;
	tonightBedMin: number;
	tonightWakeMin: number;
	daysToTarget: number;
	windDownMin: number;
	earlyWakingDetected: boolean;
	actualLastSleepHours: number | null;
	advice: string;
}

/**
 * Compute tonight's healthy sleep target + gradual circadian anchor shift AND
 * sleep-continuity protections for early-morning awakenings (e.g. waking at 04:00-05:00
 * despite sleeping early).
 */
export function computeSleepAnchorForDate(
	sleep: SleepRecoveryProfile,
	logs: Record<string, DailyHabitLog>,
	date: string,
	intensity: PlannerIntensity,
	dayOverride?: DayOverride,
): SleepScheduleCalc {
	const pastLogs = Object.values(logs)
		.filter((l) => l.date < date && (journalBedtimeForNight(logs, l.date) || l.actualWakeTime))
		.sort((a, b) => b.date.localeCompare(a.date));
	const latest = pastLogs[0];
	const todayLog = logs[date];

	const effectiveSleepHours =
		intensity === "healthy"
			? Math.max(sleep.targetSleepHours, 7.5)
			: intensity === "intensive"
				? clamp(sleep.targetSleepHours, 6, 7.5)
				: sleep.targetSleepHours;
	const sleepDurMin = Math.round(effectiveSleepHours * 60);
	const windDownMin = clamp(Math.round(sleep.windDownBufferMin ?? (sleep.earlyWakingIssue ? 40 : 25)), 15, 60);

	// Anchor current bedtime from the most recent logged bedtime (or profile setting)
	const previousNight = journalBedtimeForNight(logs, addDaysToDate(date, -1));
	const latestBedtime = previousNight?.time ?? (latest ? journalBedtimeForNight(logs, latest.date)?.time : undefined);
	const baselineBedNorm = normalizeBedtimeMin(latestBedtime ?? sleep.currentBedtime);
	const targetBedNorm = normalizeBedtimeMin(sleep.targetBedtime);

	// Today's actual/estimated/overridden wake time
	let todayWakeMin: number;
	const overrideWake = parseClockMin(dayOverride?.wakeTime);
	const todayWake = journalWakeForDate(logs, date);
	const explicitTodayWake = parseClockMin(todayWake?.time);
	const latestWake = parseClockMin(latest?.actualWakeTime);
	if (overrideWake !== null) {
		todayWakeMin = clamp(overrideWake, 4 * 60, 15 * 60);
	} else if (explicitTodayWake !== null) {
		todayWakeMin = clamp(explicitTodayWake, 4 * 60, 15 * 60);
	} else if (latestWake !== null) {
		todayWakeMin = clamp(latestWake, 4 * 60, 15 * 60);
	} else {
		const rawWake = (baselineBedNorm + sleepDurMin) % 1440;
		todayWakeMin = clamp(rawWake < 4 * 60 ? 7 * 60 : rawWake, 4 * 60, 15 * 60);
	}

	let actualLastSleepHours: number | null = null;
	if (previousNight && todayWake) {
		const prevBed = normalizeBedtimeMin(previousNight.time);
		const wakeOnAxis = todayWakeMin < 15 * 60 ? todayWakeMin + 1440 : todayWakeMin;
		const sleptMin = wakeOnAxis - prevBed;
		if (sleptMin >= 120 && sleptMin <= 840) {
			actualLastSleepHours = Math.round((sleptMin / 60) * 10) / 10;
		}
	}

	const preferredWakeParsed = parseClockMin(sleep.preferredWakeTime);
	const wokeBeforePreferred =
		preferredWakeParsed !== null && todayWakeMin < preferredWakeParsed - 45;
	const earlyWakingDetected = Boolean(
		sleep.earlyWakingIssue ||
		todayLog?.wokeEarlyUnintended ||
		wokeBeforePreferred ||
		(actualLastSleepHours !== null && actualLastSleepHours < effectiveSleepHours - 0.8),
	);

	const diff = baselineBedNorm - targetBedNorm;
	let tonightBedNorm: number;
	let daysToTarget = 0;
	let advice: string;

	const overrideBedParsed = parseClockMin(dayOverride?.bedTime);
	if (overrideBedParsed !== null && dayOverride?.bedTime) {
		tonightBedNorm = normalizeBedtimeMin(dayOverride.bedTime);
		advice = `Custom sleep window for ${date}: wake ${formatClockMin(todayWakeMin)}, screen-off ${formatClockMin(tonightBedNorm - windDownMin)}, sleep by ${formatClockMin(tonightBedNorm)}.`;
	} else if (diff > 15) {
		const step = Math.min(diff, sleep.shiftStepMinPerDay);
		tonightBedNorm = baselineBedNorm - step;
		const remainingAfterTonight = Math.max(0, tonightBedNorm - targetBedNorm);
		daysToTarget = remainingAfterTonight > 0 ? Math.ceil(remainingAfterTonight / sleep.shiftStepMinPerDay) : 0;
		advice =
			`Sleep shift: pull bedtime earlier by ${step}m to ${formatClockMin(tonightBedNorm)}` +
			` (from ${formatClockMin(baselineBedNorm)}, target ${formatClockMin(targetBedNorm)}` +
			(daysToTarget > 0 ? `, ~${daysToTarget + 1} nights left)` : ` tonight!)`);
	} else if (diff < -45) {
		tonightBedNorm = Math.min(targetBedNorm, baselineBedNorm + sleep.shiftStepMinPerDay);
		advice = `Sleep schedule steady around ${formatClockMin(tonightBedNorm)}.`;
	} else {
		tonightBedNorm = targetBedNorm;
		advice = `On sleep target: screen-off ${formatClockMin(tonightBedNorm - windDownMin)}, sleep at ${formatClockMin(tonightBedNorm)}.`;
	}

	if (earlyWakingDetected) {
		const wakeTargetStr = sleep.preferredWakeTime ?? formatClockMin(tonightBedNorm + sleepDurMin);
		const deficitStr = actualLastSleepHours !== null ? ` (~${actualLastSleepHours}h slept)` : "";
		advice =
			`Sleep continuity focus${deficitStr}: screen/game off by ${formatClockMin(tonightBedNorm - windDownMin)}, avoid napping past 14:30, aim to stay asleep until ${wakeTargetStr}.`;
	}

	// Ensure at least a valid daytime window
	if (tonightBedNorm <= todayWakeMin + 360) {
		tonightBedNorm = Math.max(todayWakeMin + 720, 23 * 60);
	}

	const tonightWakeMin = preferredWakeParsed ?? (tonightBedNorm + sleepDurMin) % 1440;
	return {
		todayWakeMin,
		tonightBedMin: tonightBedNorm,
		tonightWakeMin,
		daysToTarget,
		windDownMin,
		earlyWakingDetected,
		actualLastSleepHours,
		advice,
	};
}

// ─── Loop Habit Score, 90m Cycles & Circadian Drift ──────────────────────────

/**
 * Exponential smoothing formula adapted from Loop Habit Tracker (`uhabits` Score.kt):
 * missing one day decays strength gently instead of resetting streaks to 0.
 */
export function computeLoopHabitStep(previousScore: number, checkmarkValue: number, frequency = 1.0): number {
	const multiplier = Math.pow(0.5, Math.sqrt(Math.max(0.1, frequency)) / 13.0);
	return clamp(previousScore, 0, 1) * multiplier + clamp(checkmarkValue, 0, 1) * (1 - multiplier);
}

export function computeHabitStrengthSummary(
	config: PlannerConfig,
	date: string,
	tonightBedMin?: number,
): HabitStrengthSummary {
	const bedBase = (tonightBedMin ?? normalizeBedtimeMin(config.lifestyle.sleep.currentBedtime)) + 15;
	const cycleWakeSuggestions = [4, 5, 6].map((c) => {
		const hrs = c * 1.5;
		return `${formatClockMin(bedBase + c * 90)} (${c} cycles · ${c % 2 ? hrs.toFixed(1) : hrs.toFixed(0)}h)`;
	});

	const bedtimeLogs = Object.values(config.logs)
		.filter((l) => l.date <= date && Boolean(l.actualBedtime))
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, 14)
		.reverse();
	let circadianDriftMin = 0;
	if (bedtimeLogs.length === 1) {
		circadianDriftMin = Math.round(
			Math.abs(normalizeBedtimeMin(bedtimeLogs[0]!.actualBedtime!) - normalizeBedtimeMin(config.lifestyle.sleep.targetBedtime)),
		);
	} else if (bedtimeLogs.length >= 2) {
		let driftSum = 0;
		for (let i = 1; i < bedtimeLogs.length; i++) {
			driftSum += Math.abs(
				normalizeBedtimeMin(bedtimeLogs[i]!.actualBedtime!) - normalizeBedtimeMin(bedtimeLogs[i - 1]!.actualBedtime!),
			);
		}
		circadianDriftMin = Math.round(driftSum / (bedtimeLogs.length - 1));
	}

	const windowStart = addDaysToDate(date, -28);
	const loggedInWindow = Object.keys(config.logs)
		.filter((d) => d <= date && d >= windowStart)
		.sort((a, b) => a.localeCompare(b));
	if (loggedInWindow.length === 0) {
		return {
			overallPct: 0,
			sleepPct: 0,
			studyPct: 0,
			mealsPct: 0,
			hobbyPct: 0,
			circadianDriftMin,
			cycleWakeSuggestions,
		};
	}

	const targetBedNorm = normalizeBedtimeMin(config.lifestyle.sleep.targetBedtime);
	const recBedNorm = tonightBedMin ?? targetBedNorm;
	let sleep = 0.45;
	let study = 0.45;
	let meals = 0.45;
	let hobby = 0.45;

	for (let cur = loggedInWindow[0]!; cur <= date; cur = addDaysToDate(cur, 1)) {
		const log = config.logs[cur];
		if (cur === date && !log) continue;

		let sleepCheck = 0;
		if (log?.sleepOnTarget) {
			sleepCheck = 1;
		} else if (log?.actualBedtime) {
			const actualNorm = normalizeBedtimeMin(log.actualBedtime);
			const diffMin = Math.min(Math.abs(actualNorm - targetBedNorm), Math.abs(actualNorm - recBedNorm));
			sleepCheck = diffMin <= 30 ? 1 : diffMin <= 75 ? 0.65 : 0.25;
		}

		const totalStudyMin = Object.values(log?.loggedStudyMinBySubject ?? {}).reduce((a, b) => a + b, 0);
		const studyCheck = (log?.completedBlockIds.length ?? 0) >= 2 ? 1 : clamp(totalStudyMin / 90, 0, 1);
		const mealsCheck = log?.mealsOk ? 1 : 0;
		const hobbyCheck = log?.hobbyDone ? 1 : 0;

		if (cur < date || sleepCheck > 0) sleep = computeLoopHabitStep(sleep, sleepCheck);
		if (cur < date || studyCheck > 0) study = computeLoopHabitStep(study, studyCheck);
		if (cur < date || mealsCheck > 0) meals = computeLoopHabitStep(meals, mealsCheck);
		if (cur < date || hobbyCheck > 0) hobby = computeLoopHabitStep(hobby, hobbyCheck);
	}

	const sleepPct = Math.round(sleep * 100);
	const studyPct = Math.round(study * 100);
	const mealsPct = Math.round(meals * 100);
	const hobbyPct = Math.round(hobby * 100);
	const overallPct = Math.round((sleepPct + studyPct + mealsPct + hobbyPct) / 4);

	return {
		overallPct,
		sleepPct,
		studyPct,
		mealsPct,
		hobbyPct,
		circadianDriftMin,
		cycleWakeSuggestions,
	};
}

// ─── Timeline Carving & Scheduling ───────────────────────────────────────────

interface TimeInterval {
	startMin: number;
	endMin: number;
}

function subtractInterval(intervals: TimeInterval[], busy: TimeInterval): TimeInterval[] {
	const out: TimeInterval[] = [];
	for (const iv of intervals) {
		if (busy.endMin <= iv.startMin || busy.startMin >= iv.endMin) {
			out.push(iv);
			continue;
		}
		if (busy.startMin > iv.startMin) out.push({ startMin: iv.startMin, endMin: busy.startMin });
		if (busy.endMin < iv.endMin) out.push({ startMin: busy.endMin, endMin: iv.endMin });
	}
	return out;
}

/**
 * DueCue-inspired adaptive pace feedback: compares past logged study minutes
 * against planned quotas for a subject to adjust future time estimates.
 */
export function computeSubjectPaceMultiplier(subject: string, config: PlannerConfig, date: string): number {
	const needle = subject.trim().toLowerCase();
	if (!needle) return 1.0;

	const pastDates = Object.keys(config.logs)
		.filter((d) => d < date && Boolean(config.plans[d]))
		.sort((a, b) => b.localeCompare(a))
		.slice(0, 10);

	let actualSum = 0;
	let plannedSum = 0;
	for (const d of pastDates) {
		const log = config.logs[d];
		const plan = config.plans[d];
		if (!log || !plan) continue;
		const actualEntry = Object.entries(log.loggedStudyMinBySubject).find(([k]) => k.toLowerCase() === needle);
		const plannedQuota = plan.quotas.find((q) => q.subject.toLowerCase() === needle);
		const aMin = actualEntry?.[1] ?? 0;
		const pMin = plannedQuota?.targetMin ?? 0;
		if (aMin > 0 && pMin > 0) {
			actualSum += aMin;
			plannedSum += pMin;
		}
	}

	if (plannedSum < 25) return 1.0;
	const ratio = actualSum / plannedSum;
	if (ratio > 1.05) {
		return clamp(Math.round(ratio * 100) / 100, 1.0, 1.45);
	}
	if (ratio < 0.85) {
		return clamp(Math.round((1 + (1 - ratio) * 0.35) * 100) / 100, 0.85, 1.45);
	}
	return 1.0;
}

interface SubjectCandidate {
	subject: string;
	milestone?: StudyMilestone;
	signal?: PlannerSubjectSignal;
	urgencyScore: number;
	paceMultiplier: number;
	cognitiveLoad: CognitiveLoad;
	neededMinToday: number;
	reason: string;
	weaknessSummary?: string;
	checklist: QuotaChecklistItem[];
}

function matchSignalForMilestone(
	ms: StudyMilestone,
	signals: PlannerPersonalSignals,
): PlannerSubjectSignal | undefined {
	if (ms.clusterIds.length > 0) {
		const exact = signals.subjectSignals.find((s) => ms.clusterIds.includes(s.clusterId));
		if (exact) return exact;
	}
	const needle = ms.subject.toLowerCase();
	const titleNeedle = ms.title.toLowerCase();
	return signals.subjectSignals.find((s) => {
		const hay = s.label.toLowerCase();
		return hay.includes(needle) || needle.includes(hay) || hay.includes(titleNeedle);
	});
}

function findLearningMetricsForSubject(
	subject: string,
	profile?: PlannerLearningProfile,
): SubjectLearningMetrics | undefined {
	if (!profile || !profile.bySubject) return undefined;
	const target = normalizeSubjectKey(subject);
	if (!target) return undefined;
	for (const [k, metrics] of Object.entries(profile.bySubject)) {
		const mk = normalizeSubjectKey(k);
		if (mk === target || (mk.length >= 4 && (target.includes(mk) || mk.includes(target)))) {
			return metrics;
		}
	}
	return undefined;
}

function resolveCombinedPaceMultiplier(
	subject: string,
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	date: string,
): number {
	const plannerPace = computeSubjectPaceMultiplier(subject, config, date);
	const profile = signals.learningProfile;
	if (!profile || !profile.sufficientData) return plannerPace;
	const subMetrics = findLearningMetricsForSubject(subject, profile);
	const measuredPace = subMetrics?.paceFactor ?? 1.0;
	if (plannerPace === 1.0) return measuredPace;
	return clamp(Math.round((plannerPace * 0.6 + measuredPace * 0.4) * 100) / 100, 0.75, 1.65);
}

/**
 * Look back over the last 3 days and compute safely amortized study deficit
 * so missed sessions carry forward gently over several days without causing burnout spikes.
 */
export function computeCarryoverDeficit(
	config: PlannerConfig,
	date: string,
): { totalShortfallMin: number; amortizedTodayMin: number; bySubject: Record<string, number> } {
	let totalShortfallMin = 0;
	const bySubject: Record<string, number> = {};
	for (let d = 1; d <= 3; d++) {
		const pastDate = addDaysToDate(date, -d);
		const plan = config.plans[pastDate];
		const log = config.logs[pastDate];
		if (!plan || !log) continue;
		const hasActivity =
			Object.keys(log.loggedStudyMinBySubject).length > 0 ||
			log.completedBlockIds.length > 0 ||
			Boolean(log.compliance) ||
			(log.actualEntries?.length ?? 0) > 0;
		if (!hasActivity) continue;
		const weight = d === 1 ? 1.0 : d === 2 ? 0.65 : 0.35;
		for (const q of plan.quotas) {
			if (isSubjectMuted(q.subject, config.mutedSubjects)) continue;
			const logged = log.loggedStudyMinBySubject[q.subject] ?? 0;
			const deficit = Math.max(0, q.targetMin - logged);
			if (deficit >= 15) {
				const weighted = Math.round((deficit * weight) / 3);
				if (weighted >= 10) {
					totalShortfallMin += Math.round(deficit * weight);
					const key = normalizeSubjectKey(q.subject);
					bySubject[key] = (bySubject[key] ?? 0) + weighted;
				}
			}
		}
	}
	const amortizedTodayMin = clamp(Math.round(Object.values(bySubject).reduce((a, b) => a + b, 0) / 5) * 5, 0, 75);
	return { totalShortfallMin, amortizedTodayMin, bySubject };
}

function isSubjectInList(subject: string, list?: readonly string[]): boolean {
	if (!list || list.length === 0) return false;
	const target = normalizeSubjectKey(subject);
	return list.some((entry) => {
		const ek = normalizeSubjectKey(entry);
		return ek === target || (ek.length >= 4 && (target.includes(ek) || ek.includes(target)));
	});
}

function collectSubjectCandidates(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	opts?: { targetDate?: string; rotationOffset?: number; carryoverBySubject?: Record<string, number> },
): SubjectCandidate[] {
	const targetDate = opts?.targetDate ?? signals.date;
	const rotationOffset = opts?.rotationOffset ?? 0;
	const dayOverride = config.dayOverrides?.[targetDate];
	const focusSet = dayOverride?.focusSubjects ?? [];
	const hasExplicitFocus = focusSet.length > 0;
	const maxDailyCap = resolveSubjectMaxDailyCap(config);
	const effectiveCap = hasExplicitFocus ? Math.max(focusSet.length, Math.min(2, maxDailyCap)) : maxDailyCap;

	const primaryCandidates: SubjectCandidate[] = [];
	const backgroundCandidates: SubjectCandidate[] = [];
	const coveredClusterIds = new Set<string>();
	const coveredSubjectKeys = new Set<string>();

	// Merge milestones + any active ExamPrep exam profiles not yet represented as milestones
	const milestones: StudyMilestone[] = [...config.milestones];
	const existingExamProfileIds = new Set([
		...milestones.map((m) => m.examProfileId).filter((id): id is string => Boolean(id)),
		...(config.dismissedExamProfileIds ?? []),
	]);
	for (const ex of signals.examPrep.config.exams ?? []) {
		if (existingExamProfileIds.has(ex.id)) continue;
		const matchingScopeLabels = signals.examPrep.availableScopes
			.filter((s) => ex.clusterIds.includes(s.id))
			.map((s) => s.label);
		milestones.push({
			id: `ep_${ex.id}`,
			kind: ex.title.toLowerCase().includes("olympic") || ex.title.toLowerCase().includes("contest")
				? "competition"
				: "exam",
			title: ex.title,
			subject: matchingScopeLabels[0] || ex.title,
			dueDate: ex.date || addDaysToDate(signals.date, 21),
			priority: ex.pace === "crash-course" ? 3 : 2,
			cognitiveLoad: "heavy",
			clusterIds: [...ex.clusterIds],
			estimatedHours: ex.pace === "thorough" ? 24 : ex.pace === "efficient" ? 16 : 10,
			completedHours: 0,
			syllabusTopics: [],
			notes: "Synced from Exam Prep profile",
			examProfileId: ex.id,
		});
	}

	for (const ms of milestones) {
		const isFocusedToday = isSubjectInList(ms.subject, focusSet) || isSubjectInList(ms.title, focusSet);
		if (!isFocusedToday && isSubjectMuted(ms.subject, config.mutedSubjects)) continue;
		const daysLeft = Math.max(0, daysBetweenDates(targetDate, ms.dueDate));
		const remHours = Math.max(0.5, ms.estimatedHours - ms.completedHours);
		const sig = matchSignalForMilestone(ms, signals);
		if (sig) coveredClusterIds.add(sig.clusterId);
		for (const cid of ms.clusterIds) coveredClusterIds.add(cid);
		coveredSubjectKeys.add(normalizeSubjectKey(ms.subject));

		const deadlinePressure = daysLeft === 0 ? 120 : 75 / Math.pow(daysLeft, 0.72);
		const workloadPressure = clamp((remHours / Math.max(1, daysLeft)) * 18, 0, 60);
		const priorityBonus = ms.priority === 3 ? 28 : ms.priority === 2 ? 14 : 4;
		const kindBonus = ms.kind === "competition" ? 16 : ms.kind === "exam" ? 10 : 6;
		const graphWeaknessBonus = sig
			? sig.dueCount * 5 + sig.weakCount * 6 + sig.untrackedCount * 1.5 + (100 - sig.readinessPct) * 0.25
			: 0;
		const carryoverMin = clamp(opts?.carryoverBySubject?.[normalizeSubjectKey(ms.subject)] ?? 0, 0, 45);
		const focusBoost = isFocusedToday ? 220 : hasExplicitFocus && daysLeft > 2 ? -65 : 0;
		const urgencyScore = Math.round(
			deadlinePressure + workloadPressure + priorityBonus + kindBonus + graphWeaknessBonus + focusBoost + carryoverMin * 0.4,
		);

		const checklist: QuotaChecklistItem[] = [];
		const openTopics = ms.syllabusTopics.filter((t) => !t.done).slice(0, 2);
		for (const t of openTopics) {
			checklist.push({ id: `chk_${ms.id}_${t.id}`, text: clipPreservingLatex(`Topic: ${t.title} (~${t.estHours}h)`, 150) });
		}
		if (sig?.pendingProblems && sig.pendingProblems.length > 0 && checklist.length < 3) {
			checklist.push({
				id: `chk_${ms.id}_prob`,
				text: clipPreservingLatex(`Solve pending: ${sig.pendingProblems[0]}`, 150),
			});
		}
		if (sig?.activePlanTopics && sig.activePlanTopics.length > 0 && checklist.length < 3) {
			checklist.push({
				id: `chk_${ms.id}_plan`,
				text: clipPreservingLatex(`Session path: ${sig.activePlanTopics[0]}`, 150),
			});
		}
		if (sig && sig.dueCount > 0 && checklist.length < 4) {
			const sample = sig.dueSampleNames.slice(0, 2).map((s) => clipPreservingLatex(s, 55)).join(", ");
			checklist.push({
				id: `chk_${ms.id}_fsrs`,
				text: `Review ${sig.dueCount} due FSRS card${sig.dueCount === 1 ? "" : "s"}${sample ? ` (${sample})` : ""}`,
			});
		}
		if (sig && sig.weakCount > 0 && checklist.length < 4) {
			const sample = sig.weakSampleNames.slice(0, 2).map((s) => clipPreservingLatex(s, 55)).join(", ");
			checklist.push({
				id: `chk_${ms.id}_weak`,
				text: `Drill weak foundation${sig.weakCount === 1 ? "" : "s"}${sample ? `: ${sample}` : ""}`,
			});
		}
		if (checklist.length === 0 && sig?.untrackedSampleNames && sig.untrackedSampleNames.length > 0) {
			const nextNodes = sig.untrackedSampleNames.slice(0, 2).map((s) => clipPreservingLatex(s, 50)).join(", ");
			checklist.push({
				id: `chk_${ms.id}_untracked`,
				text: `Study next foundations: ${nextNodes}`,
			});
		}
		if (checklist.length === 0 && sig?.attachedFiles && sig.attachedFiles.length > 0) {
			checklist.push({
				id: `chk_${ms.id}_file`,
				text: `Practice from ${sig.attachedFiles[0]}`,
			});
		}
		if (checklist.length === 0) {
			checklist.push({
				id: `chk_${ms.id}_core`,
				text: `Advance ${ms.title} (+${ms.cognitiveLoad === "heavy" ? "deep problem set" : "focused practice"})`,
			});
		}

		const parts: string[] = [];
		parts.push(daysLeft === 0 ? "Due today" : `D-${daysLeft}`);
		if (remHours > 0) parts.push(`${Math.round(remHours * 10) / 10}h left`);
		if (carryoverMin >= 10) parts.push(`+${carryoverMin}m carryover`);
		if (sig && (sig.dueCount > 0 || sig.weakCount > 0)) {
			parts.push(`${sig.dueCount} due · ${sig.weakCount} weak`);
		}

		const weaknessSummary = sig
			? `${sig.readinessPct}% ready · ${sig.dueCount} FSRS due · ${sig.weakCount} weak · ${sig.untrackedCount} untracked`
			: undefined;

		const paceMultiplier = resolveCombinedPaceMultiplier(ms.subject, config, signals, targetDate);
		primaryCandidates.push({
			subject: ms.subject,
			milestone: ms,
			signal: sig,
			urgencyScore: Math.max(10, urgencyScore),
			paceMultiplier,
			cognitiveLoad: ms.cognitiveLoad,
			neededMinToday: clamp(Math.round((remHours / Math.max(1, daysLeft)) * 60 * paceMultiplier + carryoverMin), 35, 240),
			reason: parts.join(" · "),
			weaknessSummary,
			checklist,
		});
	}

	// Non-exam Knowledge Graph clusters: promoted if pinned/focused today; otherwise kept in background maintenance pool
	for (const sig of signals.subjectSignals) {
		if (coveredClusterIds.has(sig.clusterId)) continue;
		const sigKey = normalizeSubjectKey(sig.label);
		if (coveredSubjectKeys.has(sigKey)) continue;
		const isFocusedToday = isSubjectInList(sig.label, focusSet);
		const isPinned = isSubjectInList(sig.label, config.pinnedSubjects);
		if (!isFocusedToday && isSubjectMuted(sig.label, config.mutedSubjects)) continue;

		const staleDays = sig.lastStudiedAt
			? clamp(daysBetweenDates(sig.lastStudiedAt.slice(0, 10), targetDate), 0, 14)
			: 5;
		const carryoverMin = clamp(opts?.carryoverBySubject?.[sigKey] ?? 0, 0, 35);
		const urgencyScore = Math.round(
			20 +
				sig.dueCount * 5 +
				sig.weakCount * 6 +
				sig.untrackedCount * 1.2 +
				(100 - sig.readinessPct) * 0.3 +
				staleDays * 2 +
				(isFocusedToday ? 220 : isPinned ? 45 : 0),
		);
		const checklist: QuotaChecklistItem[] = [];
		if (sig.pendingProblems && sig.pendingProblems.length > 0) {
			checklist.push({
				id: `chk_sig_${sig.clusterId}_prob`,
				text: clipPreservingLatex(`Finish problem: ${sig.pendingProblems[0]}`, 150),
			});
		}
		if (sig.dueCount > 0) {
			const sample = sig.dueSampleNames[0] ? clipPreservingLatex(sig.dueSampleNames[0], 55) : "";
			checklist.push({
				id: `chk_sig_${sig.clusterId}_due`,
				text: `FSRS review: ${sig.dueCount} card${sig.dueCount === 1 ? "" : "s"}${sample ? ` (${sample})` : ""}`,
			});
		}
		if (sig.activePlanTopics && sig.activePlanTopics.length > 0) {
			checklist.push({
				id: `chk_sig_${sig.clusterId}_plan`,
				text: clipPreservingLatex(`Next chapter: ${sig.activePlanTopics[0]}`, 150),
			});
		}
		if (checklist.length < 2 && (sig.weakCount > 0 || (sig.untrackedSampleNames?.length ?? 0) > 0)) {
			const targets = sig.weakSampleNames.length > 0 ? sig.weakSampleNames : sig.untrackedSampleNames ?? [];
			const sample = targets.slice(0, 2).map((s) => clipPreservingLatex(s, 45)).join(", ");
			checklist.push({
				id: `chk_sig_${sig.clusterId}_weak`,
				text: sample ? `Master ${sig.label}: ${sample}` : `Strengthen ${sig.label} (${sig.weakCount} weak, ${sig.untrackedCount} untracked)`,
			});
		}
		if (checklist.length === 0) {
			const fallbackHint = sig.attachedFiles?.[0] ? `Practice ${sig.attachedFiles[0]}` : `Active recall check on ${sig.label}`;
			checklist.push({ id: `chk_sig_${sig.clusterId}_rev`, text: fallbackHint });
		}
		const paceMultiplier = resolveCombinedPaceMultiplier(sig.label, config, signals, targetDate);
		const cand: SubjectCandidate = {
			subject: sig.label,
			signal: sig,
			urgencyScore,
			paceMultiplier,
			cognitiveLoad: sig.weakCount > 2 || sig.untrackedCount > 5 ? "heavy" : "medium",
			neededMinToday: clamp(Math.round((35 + sig.dueCount * 6 + sig.weakCount * 9) * paceMultiplier + carryoverMin), 30, 120),
			reason: `${sig.readinessPct}% ready · ${sig.dueCount} due`,
			weaknessSummary: `${sig.readinessPct}% ready · ${sig.dueCount} FSRS due · ${sig.weakCount} weak`,
			checklist,
		};
		if (isFocusedToday || isPinned) {
			primaryCandidates.push(cand);
		} else {
			backgroundCandidates.push(cand);
		}
	}

	// Build final focused candidate list (honoring day focus override + multi-day rotation across week)
	const sortedPrimary = primaryCandidates.sort((a, b) => b.urgencyScore - a.urgencyScore);
	const sortedBackground = backgroundCandidates.sort((a, b) => b.urgencyScore - a.urgencyScore);

	let chosen: SubjectCandidate[] = [];
	if (hasExplicitFocus) {
		const matchedFocus = [...sortedPrimary, ...sortedBackground].filter(
			(c) => isSubjectInList(c.subject, focusSet) || (c.milestone && isSubjectInList(c.milestone.title, focusSet)),
		);
		const urgentOverflow = sortedPrimary.filter(
			(c) => !matchedFocus.includes(c) && c.milestone && daysBetweenDates(targetDate, c.milestone.dueDate) <= 2,
		);
		chosen = [...matchedFocus, ...urgentOverflow].slice(0, effectiveCap);
		// If user typed a brand-new focus subject not yet in milestones/graph, synthesize a clean block for it
		if (chosen.length === 0) {
			for (const f of focusSet.slice(0, 2)) {
				chosen.push({
					subject: f,
					urgencyScore: 140,
					paceMultiplier: resolveCombinedPaceMultiplier(f, config, signals, targetDate),
					cognitiveLoad: "heavy",
					neededMinToday: 120,
					reason: "Focused study priority",
					checklist: [{ id: `chk_focus_${normalizeSubjectKey(f)}`, text: `Deep work sprint on ${f}` }],
				});
			}
		}
	} else if (sortedPrimary.length > 0) {
		// Always include top urgent target + rotate secondary milestones across weekdays when > maxDailyCap
		const fixedTopCount = sortedPrimary.length <= effectiveCap ? sortedPrimary.length : Math.max(1, effectiveCap - 1);
		chosen = sortedPrimary.slice(0, fixedTopCount);
		if (sortedPrimary.length > fixedTopCount) {
			const rotatingPool = sortedPrimary.slice(fixedTopCount);
			for (let i = 0; i < rotatingPool.length && chosen.length < effectiveCap; i++) {
				const idx = (rotationOffset + i) % rotatingPool.length;
				chosen.push(rotatingPool[idx]!);
			}
		}
		// Only fill remaining spare slot with urgent FSRS/weak Graph cluster when not in healthy mode
		if (chosen.length < effectiveCap && config.intensity !== "healthy") {
			const urgentBg = sortedBackground.filter((b) => (b.signal?.dueCount ?? 0) > 0 || (b.signal?.weakCount ?? 0) > 0);
			if (urgentBg.length > 0) {
				chosen.push(urgentBg[rotationOffset % urgentBg.length]!);
			}
		}
	} else if (sortedBackground.length > 0) {
		if (sortedBackground.length <= effectiveCap) {
			chosen = sortedBackground;
		} else {
			chosen = [sortedBackground[0]!];
			const rest = sortedBackground.slice(1);
			for (let i = 0; i < rest.length && chosen.length < effectiveCap; i++) {
				chosen.push(rest[(rotationOffset + i) % rest.length]!);
			}
		}
	}

	// General fallback when workspace has no milestones and all clusters are absent/muted
	if (chosen.length === 0) {
		const firstSession = signals.recentSessions[0]?.title || "Core Foundations";
		chosen.push({
			subject: firstSession,
			urgencyScore: 40,
			paceMultiplier: 1.0,
			cognitiveLoad: "medium",
			neededMinToday: 90,
			reason: "Build daily momentum",
			checklist: [{ id: "chk_default_focus", text: `Complete focused study session in ${firstSession}` }],
		});
	}

	return chosen.sort((a, b) => b.urgencyScore - a.urgencyScore).slice(0, effectiveCap);
}

export interface SchedulableSlot {
	startMin: number;
	endMin: number;
	isPeak: boolean;
	rank?: number;
}

export interface AssignableSubject {
	subject: string;
	cognitiveLoad: CognitiveLoad;
}

export interface DipTimeWindow {
	startMin: number;
	endMin: number;
}

function scoreAssignmentOrder<T extends AssignableSubject>(
	rawSlots: readonly SchedulableSlot[],
	assignments: ReadonlyArray<T | null>,
	tonightBedMin: number,
	dipWindow?: DipTimeWindow | null,
): number {
	let score = 0;
	let prevIdx = -1;
	const firstIdxBySubject = new Map<string, number>();

	for (let i = 0; i < rawSlots.length; i++) {
		const cand = assignments[i];
		if (!cand) continue;
		const slot = rawSlots[i]!;

		if (cand.cognitiveLoad === "heavy" && slot.isPeak) score += 25;
		if (cand.cognitiveLoad === "heavy" && slot.endMin >= tonightBedMin - 90) score -= 15;
		if (dipWindow && slot.endMin > dipWindow.startMin && slot.startMin < dipWindow.endMin) {
			if (cand.cognitiveLoad === "heavy") score -= 45;
			else if (cand.cognitiveLoad === "medium") score -= 10;
			else score += 22;
		}

		if (prevIdx >= 0) {
			const prevCand = assignments[prevIdx]!;
			const prevSlot = rawSlots[prevIdx]!;
			if (slot.startMin - prevSlot.endMin <= 25) {
				if (prevCand.subject === cand.subject) score -= 45;
				if (prevCand.cognitiveLoad === "heavy" && cand.cognitiveLoad === "heavy") score -= 35;
			}
		}

		const firstIdx = firstIdxBySubject.get(cand.subject);
		if (firstIdx === undefined) {
			firstIdxBySubject.set(cand.subject, i);
		} else if (slot.startMin - rawSlots[firstIdx]!.endMin >= 120) {
			score += 15;
		}
		prevIdx = i;
	}
	return score;
}

/**
 * Timefold / CP-SAT style 2-opt constraint refinement pass over focus slots:
 * avoids consecutive single-subject streaks & back-to-back heavy blocks while
 * rewarding peak-hour alignment, spaced intervals, and post-meal light load.
 */
export function optimizeSlotAssignments<T extends AssignableSubject>(
	rawSlots: readonly SchedulableSlot[],
	initialAssignments: ReadonlyArray<T | null>,
	tonightBedMin: number,
	dipWindow?: DipTimeWindow | null,
): Array<T | null> {
	const best = [...initialAssignments];
	if (best.length < 2) return best;

	let bestScore = scoreAssignmentOrder(rawSlots, best, tonightBedMin, dipWindow);
	for (let pass = 0; pass < 3; pass++) {
		let improved = false;
		for (let i = 0; i < best.length; i++) {
			for (let j = i + 1; j < best.length; j++) {
				if (best[i] === best[j]) continue;
				const tmp = best[i]!;
				best[i] = best[j]!;
				best[j] = tmp;
				const nextScore = scoreAssignmentOrder(rawSlots, best, tonightBedMin, dipWindow);
				if (nextScore > bestScore) {
					bestScore = nextScore;
					improved = true;
				} else {
					best[j] = best[i]!;
					best[i] = tmp;
				}
			}
		}
		if (!improved) break;
	}
	return best;
}

function resolveBusyEventsForDate(
	config: PlannerConfig,
	date: string,
): Array<{ id: string; startTime: string; endTime: string; title: string; reason: string }> {
	const weekday = weekdayForDate(date);
	const override = config.dayOverrides?.[date];
	const out: Array<{ id: string; startTime: string; endTime: string; title: string; reason: string }> = [];
	if (!override?.skipFixedEvents) {
		for (const ev of config.fixedEvents) {
			if (ev.dayOfWeek !== weekday) continue;
			out.push({
				id: `blk_fix_${ev.id}`,
				startTime: ev.startTime,
				endTime: ev.endTime,
				title: ev.title,
				reason: `Fixed ${ev.category}`,
			});
		}
	}
	for (const exam of config.examTimetable ?? []) {
		if (exam.date !== date || !exam.startTime || !exam.endTime) continue;
		out.push({ id: `blk_exam_${exam.id}`, startTime: exam.startTime, endTime: exam.endTime, title: exam.title, reason: "Exam" });
	}
	for (const ev of override?.extraBusyEvents ?? []) {
		out.push({
			id: `blk_dayov_${ev.id}`,
			startTime: ev.startTime,
			endTime: ev.endTime,
			title: ev.title,
			reason: `Date ${ev.category}`,
		});
	}
	return out.sort((a, b) => (parseClockMin(a.startTime) ?? 0) - (parseClockMin(b.startTime) ?? 0));
}

function resolveEffectiveRealism(config: PlannerConfig, signals: PlannerPersonalSignals): number {
	const raw = config.realismFactor ?? signals.learningProfile?.realismFactor ?? 1.0;
	return clamp(Math.round(raw * 100) / 100, 0.65, 1.25);
}

function allocateDailyQuotasBySubject(
	candidates: readonly SubjectCandidate[],
	rawStudyBudget: number,
	focusBudgetAvailable: number,
	intensity: PlannerIntensity,
): Map<string, number> {
	const quotasBySubject = new Map<string, number>();
	if (rawStudyBudget < 20 || candidates.length === 0) return quotasBySubject;

	const urgencySum = Math.max(1, candidates.reduce((acc, c) => acc + c.urgencyScore, 0));
	const capFraction = candidates.length >= 2 && intensity !== "intensive" ? 0.58 : candidates.length >= 2 ? 0.68 : 1;
	let allocatedSum = 0;
	for (const c of candidates) {
		const rawShare = Math.round((rawStudyBudget * c.urgencyScore) / urgencySum);
		const capped = Math.min(rawShare, Math.round(rawStudyBudget * capFraction));
		const rounded = Math.max(Math.min(25, rawStudyBudget), Math.round(capped / 15) * 15);
		quotasBySubject.set(c.subject, rounded);
		allocatedSum += rounded;
	}
	if (allocatedSum > focusBudgetAvailable) {
		const ratio = (focusBudgetAvailable * 0.85) / allocatedSum;
		for (const c of candidates) {
			quotasBySubject.set(c.subject, Math.max(20, Math.round(((quotasBySubject.get(c.subject) ?? 30) * ratio) / 5) * 5));
		}
	}
	return quotasBySubject;
}

function carveAwakeScheduleBaseline(
	config: PlannerConfig,
	date: string,
	dayOverride: DayOverride | undefined,
	sleepCalc: SleepScheduleCalc,
): {
	awakeIntervals: TimeInterval[];
	fixedBlocks: PlannedBlock[];
	freeBeforeHobby: number;
	hobbyMin: number;
} {
	const fixedBlocks: PlannedBlock[] = [];
	const dayEvents = resolveBusyEventsForDate(config, date);
	let awakeIntervals: TimeInterval[] = [{ startMin: sleepCalc.todayWakeMin, endMin: sleepCalc.tonightBedMin - sleepCalc.windDownMin }];

	for (const ev of dayEvents) {
		const s = parseClockMin(ev.startTime);
		const e = parseClockMin(ev.endTime);
		if (s === null || e === null || e <= s) continue;
		const iv = { startMin: Math.max(s, sleepCalc.todayWakeMin), endMin: Math.min(e, sleepCalc.tonightBedMin - 25) };
		if (iv.endMin > iv.startMin) awakeIntervals = subtractInterval(awakeIntervals, iv);
		// Exams remain visible and busy for their entire stated duration, even if
		// the event falls outside the configured awake window.
		const shown = ev.reason === "Exam" ? { startMin: s, endMin: e } : iv;
		if (shown.endMin > shown.startMin) {
			fixedBlocks.push({
				id: ev.id,
				date,
				startTime: formatClockMin(shown.startMin),
				endTime: formatClockMin(shown.endMin),
				startMin: shown.startMin,
				endMin: shown.endMin,
				durationMin: shown.endMin - shown.startMin,
				type: "fixed",
				title: ev.title,
				reason: ev.reason,
			});
		}
	}

	const activeMeals = dayOverride?.meals && dayOverride.meals.length > 0 ? dayOverride.meals : config.lifestyle.meals;
	for (const meal of activeMeals) {
		const s = parseClockMin(meal.startTime);
		if (s === null) continue;
		const e = s + meal.durationMin;
		const iv = { startMin: Math.max(s, sleepCalc.todayWakeMin), endMin: Math.min(e, sleepCalc.tonightBedMin - sleepCalc.windDownMin) };
		if (iv.endMin - iv.startMin >= 15) {
			awakeIntervals = subtractInterval(awakeIntervals, iv);
			fixedBlocks.push({
				id: `blk_${meal.id}`,
				date,
				startTime: formatClockMin(iv.startMin),
				endTime: formatClockMin(iv.endMin),
				startMin: iv.startMin,
				endMin: iv.endMin,
				durationMin: iv.endMin - iv.startMin,
				type: "meal",
				title: meal.label,
			});
		}
	}

	const freeBeforeHobby = awakeIntervals.reduce((acc, iv) => acc + Math.max(0, iv.endMin - iv.startMin), 0);
	const band = INTENSITY_STUDY_BOUNDS[config.intensity];
	const configuredHobbies = config.lifestyle.hobbies.filter((name) => config.lifestyle.hobbyPreferences?.[name]);
	const baseHobby = configuredHobbies.length ? configuredHobbies.reduce((sum, name) => sum + config.lifestyle.hobbyPreferences![name]!.dailyMin, 0) : config.lifestyle.dailyHobbyMin;
	const targetHobbyMin =
		config.intensity === "healthy"
			? Math.max(baseHobby, band.minHobbyMin)
			: config.intensity === "intensive"
				? Math.min(baseHobby, band.minHobbyMin)
				: Math.max(baseHobby, band.minHobbyMin);
	const baseGame = config.lifestyle.gameBudgetMin ?? 0;
	const targetGameMin =
		baseGame <= 0
			? 0
			: config.intensity === "healthy"
				? baseGame
				: config.intensity === "balanced"
					? Math.round(baseGame * 0.75)
					: Math.min(baseGame, 25);
	const hobbyMin = Math.min(targetHobbyMin + targetGameMin, Math.max(0, Math.floor(freeBeforeHobby * 0.28)));
	return { awakeIntervals, fixedBlocks, freeBeforeHobby, hobbyMin };
}

function computeRealisticStudyBudget(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	date: string,
	dayOverride: DayOverride | undefined,
	focusBudgetAvailable: number,
	candidates: readonly SubjectCandidate[],
	amortizedCarryoverMin: number,
): { rawStudyBudget: number; minDailyMin: number; realism: number; examDeficitWarning?: string } {
	const band = INTENSITY_STUDY_BOUNDS[config.intensity];
	const realism = resolveEffectiveRealism(config, signals);
	const totalUrgencyNeeded = candidates.reduce((acc, c) => acc + c.neededMinToday, 0);

	const deadlineMinNeed = candidates.reduce((acc, c) => {
		if (!c.milestone) return acc + 25;
		const d = Math.max(1, daysBetweenDates(date, c.milestone.dueDate));
		const rem = Math.max(0, c.milestone.estimatedHours - c.milestone.completedHours);
		return acc + (rem / d) * 60;
	}, 0);

	const hasUrgentExam = candidates.some((c) => c.milestone && daysBetweenDates(date, c.milestone.dueDate) <= 3);
	const modeUtilization = band.utilization;
	// Strictly respect Healthy/Balanced caps unless user explicitly overrides hours for today
	const maxBandMin = Math.min(
		Math.round(focusBudgetAvailable * 0.88),
		config.intensity === "healthy"
			? band.hardCeilingMin
			: hasUrgentExam
				? Math.round(band.hardCeilingMin * 1.12)
				: band.hardCeilingMin,
	);
	const targetCapMin = Math.min(maxBandMin, Math.max(band.minFloorMin, Math.round(band.softCapMin * realism)));

	const adaptedBaseTarget = Math.min(
		Math.round(focusBudgetAvailable * modeUtilization),
		targetCapMin,
	);
	const demandTarget = Math.round((totalUrgencyNeeded + amortizedCarryoverMin * 0.5) * realism);
	const rawStudyBudget =
		dayOverride?.studyTargetHoursOverride !== undefined
			? Math.min(focusBudgetAvailable, Math.round(dayOverride.studyTargetHoursOverride * 60))
			: Math.min(
				maxBandMin,
				Math.max(
					Math.min(adaptedBaseTarget, Math.max(demandTarget, band.minFloorMin)),
					Math.min(focusBudgetAvailable, band.minFloorMin),
				),
			);

	const minDailyMin =
		dayOverride?.studyTargetHoursOverride !== undefined
			? Math.min(focusBudgetAvailable, Math.round(dayOverride.studyTargetHoursOverride * 60))
			: Math.min(
				maxBandMin,
				Math.max(60, Math.round(Math.max(Math.min(deadlineMinNeed, maxBandMin), rawStudyBudget * 0.72) / 15) * 15),
			);

	const examDeficitWarning =
		dayOverride?.studyTargetHoursOverride === undefined &&
		config.intensity !== "intensive" &&
		deadlineMinNeed > maxBandMin + 25
			? `${config.intensity === "healthy" ? "Healthy" : "Balanced"} cap keeps today <= ${(maxBandMin / 60).toFixed(1)}h/d (exam deadlines mathematically need ~${(deadlineMinNeed / 60).toFixed(1)}h/d — switch to Intensive or spread deadlines).`
			: undefined;

	return { rawStudyBudget, minDailyMin, realism, ...(examDeficitWarning ? { examDeficitWarning } : {}) };
}

function computeWeeklyForecast(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	startDate: string,
	todayCarryoverMin: number,
): WeeklyForecastDay[] {
	const out: WeeklyForecastDay[] = [];
	const carryover = computeCarryoverDeficit(config, startDate);
	for (let offset = 0; offset < 7; offset++) {
		const date = addDaysToDate(startDate, offset);
		const weekday = weekdayForDate(date);
		const dayOverride = config.dayOverrides?.[date];
		const sleepCalc = computeSleepAnchorForDate(config.lifestyle.sleep, config.logs, date, config.intensity, dayOverride);
		const { freeBeforeHobby, hobbyMin } = carveAwakeScheduleBaseline(config, date, dayOverride, sleepCalc);
		const focusAvail = Math.max(0, freeBeforeHobby - hobbyMin);

		const dayCarryover = offset === 0 ? todayCarryoverMin : offset <= 2 ? Math.round(todayCarryoverMin * 0.5) : 0;
		const candidates = collectSubjectCandidates(config, signals, {
			targetDate: date,
			rotationOffset: offset,
			carryoverBySubject: offset <= 2 ? carryover.bySubject : undefined,
		});

		const customBlocks = dayOverride?.customBlocks ?? [];
		const hasCustomBlocks = Array.isArray(dayOverride?.customBlocks);
		let plannedMin: number;
		let subjects: WeeklyForecastSubjectQuota[];
		if (hasCustomBlocks) {
			const customStudy = customBlocks.filter((b) => b.type === "study");
			plannedMin = customStudy.reduce((a, b) => a + b.durationMin, 0);
			const bySub = new Map<string, { minutes: number; hint?: string; isExam?: boolean }>();
			for (const b of customStudy) {
				const key = b.subject || b.title;
				const prev = bySub.get(key) ?? { minutes: 0, hint: b.actionTopic || b.title, isExam: Boolean(b.milestoneId) };
				prev.minutes += b.durationMin;
				bySub.set(key, prev);
			}
			subjects = [...bySub.entries()].map(([subject, info]) => ({
				subject,
				plannedMinutes: info.minutes,
				...(info.hint ? { focusHint: info.hint } : {}),
				...(info.isExam ? { isExamPriority: true } : {}),
			}));
		} else {
			const { rawStudyBudget } = computeRealisticStudyBudget(
				config,
				signals,
				date,
				dayOverride,
				focusAvail,
				candidates,
				dayCarryover,
			);
			const quotasBySubject = allocateDailyQuotasBySubject(candidates, rawStudyBudget, focusAvail, config.intensity);
			plannedMin = [...quotasBySubject.values()].reduce((a, b) => a + b, 0);
			subjects = candidates
				.filter((c) => (quotasBySubject.get(c.subject) ?? 0) > 0)
				.map((c) => ({
					subject: c.subject,
					plannedMinutes: quotasBySubject.get(c.subject) ?? 45,
					...(c.checklist[0]?.text ? { focusHint: c.checklist[0].text } : {}),
					...(c.milestone ? { isExamPriority: true } : {}),
				}));
		}

		const plannedHours = Math.round((plannedMin / 60) * 10) / 10;
		const milestoneTitles = config.milestones.filter((m) => m.dueDate === date).map((m) => m.title);
		const loadLevel: WeeklyForecastDay["loadLevel"] =
			milestoneTitles.length > 0 || plannedHours >= 5
				? "heavy"
				: plannedHours >= 2.5
					? "moderate"
					: "light";

		out.push({
			date,
			weekday,
			freeHours: Math.round((freeBeforeHobby / 60) * 10) / 10,
			plannedHours,
			loadLevel,
			milestoneTitles,
			subjects,
			...(dayCarryover > 0 ? { carryoverInMinutes: dayCarryover } : {}),
			...(hasCustomBlocks ? { isCustomEdited: true } : {}),
		});
	}
	return out;
}

function resolveEveningDipWindow(
	config: PlannerConfig,
	dayOverride: DayOverride | undefined,
	sleepCalc: SleepScheduleCalc,
): { walkIv: TimeInterval | null; dipWindow: DipTimeWindow | null } {
	const riskSet = new Set(config.lifestyle.wellnessGuardrail?.enabled ? (config.lifestyle.wellnessGuardrail.riskWindows ?? []) : []);
	const enabled = Boolean(config.lifestyle.sleep.postDinnerComaProtection || riskSet.has("post_dinner_slump"));
	if (!enabled) return { walkIv: null, dipWindow: null };

	const activeMeals = dayOverride?.meals && dayOverride.meals.length > 0 ? dayOverride.meals : config.lifestyle.meals;
	let dinnerEnd: number | null = null;
	for (const meal of activeMeals) {
		const s = parseClockMin(meal.startTime);
		if (s === null) continue;
		if (s >= 16 * 60 + 30 && s < 22 * 60) {
			dinnerEnd = s + meal.durationMin;
		}
	}

	const stopCutoff = sleepCalc.tonightBedMin - sleepCalc.windDownMin;
	const walkIv: TimeInterval | null =
		dinnerEnd !== null && dinnerEnd + 15 <= stopCutoff && dinnerEnd >= sleepCalc.todayWakeMin
			? { startMin: dinnerEnd, endMin: dinnerEnd + 15 }
			: null;

	let dipStart = walkIv ? walkIv.endMin : 20 * 60;
	const explicitDip = parseClockMin(config.lifestyle.sleep.eveningDrowsyStart);
	if (explicitDip !== null) {
		dipStart = explicitDip < sleepCalc.todayWakeMin ? explicitDip + 1440 : explicitDip;
	}
	const dipEnd = Math.min(dipStart + 75, stopCutoff);
	const dipWindow: DipTimeWindow | null = dipEnd - dipStart >= 25 ? { startMin: dipStart, endMin: dipEnd } : null;
	return { walkIv, dipWindow };
}

function synchronizeTodayForecast(forecast: WeeklyForecastDay[], quotas: DailyQuotaItem[], plannedMin: number, freeHours: number): WeeklyForecastDay[] {
	return forecast.map((day, index) => {
		if (index !== 0) return day;
		const plannedHours = Math.round((plannedMin / 60) * 10) / 10;
		return {
			...day,
			freeHours,
			plannedHours,
			loadLevel: day.milestoneTitles.length > 0 || plannedHours >= 5 ? "heavy" : plannedHours >= 2.5 ? "moderate" : "light",
			subjects: quotas.map((quota) => ({
				subject: quota.subject,
				plannedMinutes: quota.targetMin,
				...(quota.checklist[0]?.text ? { focusHint: quota.checklist[0].text } : {}),
				...(quota.milestoneId ? { isExamPriority: true } : {}),
			})),
		};
	});
}

/** Clip a newly generated plan to the current local minute, without changing saved history. */
export function clipPlannerBlocksFromNow(blocks: readonly PlannedBlock[], date: string, now: number): PlannedBlock[] {
	if (date !== localDateString(now)) return [...blocks];
	const clock = new Date(now);
	const cutoff = clock.getHours() * 60 + clock.getMinutes() + (clock.getSeconds() || clock.getMilliseconds() ? 1 : 0);
	return blocks.flatMap((block) => {
		if (block.endMin <= cutoff) return [];
		if (block.startMin >= cutoff) return [block];
		return [{ ...block, startMin: cutoff, startTime: formatClockMin(cutoff), durationMin: block.endMin - cutoff }];
	});
}

/**
 * Compute daily study schedule locally in ~1-5ms (0 tokens).
 */
export function computeLocalPlannerPlan(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	now = Date.now(),
	options: { fromNow?: boolean } = {},
): DailyStudyPlan {
	const date = signals.date;
	const limitToNow = options.fromNow === true && date === localDateString(now);
	const clock = new Date(now);
	const cutoff = limitToNow ? clock.getHours() * 60 + clock.getMinutes() + (clock.getSeconds() || clock.getMilliseconds() ? 1 : 0) : 0;
	const dayOverride = config.dayOverrides?.[date];
	const sleepCalc = computeSleepAnchorForDate(config.lifestyle.sleep, config.logs, date, config.intensity, dayOverride);
	const carryover = computeCarryoverDeficit(config, date);
	const carryoverNote =
		carryover.amortizedTodayMin > 0
			? `Adaptive carryover: +${carryover.amortizedTodayMin}m redistributed gently from recent missed blocks.`
			: undefined;

	const baseCarve = carveAwakeScheduleBaseline(config, date, dayOverride, sleepCalc);
	let awakeIntervals = baseCarve.awakeIntervals;
	if (limitToNow) awakeIntervals = subtractInterval(awakeIntervals, { startMin: 0, endMin: cutoff });
	const fixedBlocks = limitToNow ? clipPlannerBlocksFromNow(baseCarve.fixedBlocks, date, now) : baseCarve.fixedBlocks;
	const freeMinutes = limitToNow ? awakeIntervals.reduce((total, iv) => total + Math.max(0, iv.endMin - iv.startMin), 0) : baseCarve.freeBeforeHobby;
	const freeHoursTotal = Math.round((freeMinutes / 60) * 10) / 10;
	const band = INTENSITY_STUDY_BOUNDS[config.intensity];

	const guardrail = config.lifestyle.wellnessGuardrail;
	const guardrailRiskSet = new Set(guardrail?.enabled ? (guardrail.riskWindows ?? []) : []);
	const dipInfo = resolveEveningDipWindow(config, dayOverride, sleepCalc);

	// Optional restorative 25m midday power nap if early waking / short sleep happened (never past 14:30)
	const hobbyBlocks: PlannedBlock[] = [];
	let napEndMin: number | null = null;
	if (sleepCalc.earlyWakingDetected && (config.lifestyle.sleep.allowMiddayRecoveryNap ?? true)) {
		const napIdx = awakeIntervals.findIndex((iv) => iv.endMin >= 12 * 60 + 45 && iv.startMin <= 14 * 60 + 5 && Math.min(iv.endMin, 14 * 60 + 30) - Math.max(iv.startMin, 12 * 60 + 45) >= 25);
		if (napIdx >= 0) {
			const iv = awakeIntervals[napIdx]!;
			const napStart = clamp(13 * 60 + 5, iv.startMin, Math.min(iv.endMin, 14 * 60 + 30) - 25);
			const napIv = { startMin: napStart, endMin: napStart + 25 };
			awakeIntervals = subtractInterval(awakeIntervals, napIv);
			napEndMin = napIv.endMin;
			hobbyBlocks.push({
				id: `blk_nap_${date}`,
				date,
				startTime: formatClockMin(napIv.startMin),
				endTime: formatClockMin(napIv.endMin),
				startMin: napIv.startMin,
				endMin: napIv.endMin,
				durationMin: 25,
				type: "hobby",
				title: "Short Midday Recovery Nap (25m)",
				reason: "Counter early waking without delaying tonight's sleep",
			});
		}
	}

	// Discreet transition anchors for high-risk wake windows (feet on floor + water before phone/bed drift)
	if (guardrail?.enabled && (guardrailRiskSet.has("early_morning_wake") || sleepCalc.earlyWakingDetected)) {
		const firstIv = awakeIntervals[0];
		if (firstIv && firstIv.startMin === sleepCalc.todayWakeMin && firstIv.endMin - firstIv.startMin >= 35) {
			const wakeAnchorIv = { startMin: sleepCalc.todayWakeMin, endMin: sleepCalc.todayWakeMin + 10 };
			awakeIntervals = subtractInterval(awakeIntervals, wakeAnchorIv);
			hobbyBlocks.push({
				id: `blk_wake_anchor_${date}`,
				date,
				startTime: formatClockMin(wakeAnchorIv.startMin),
				endTime: formatClockMin(wakeAnchorIv.endMin),
				startMin: wakeAnchorIv.startMin,
				endMin: wakeAnchorIv.endMin,
				durationMin: 10,
				type: "break",
				title: "Start-of-Day Movement & Water (10m)",
				reason: "Feet on floor + cold water before starting desktop work",
			});
		}
	}

	if (guardrail?.enabled && guardrailRiskSet.has("post_nap_wake") && napEndMin !== null) {
		const postNapIv = { startMin: napEndMin, endMin: napEndMin + 10 };
		const fitsPostNap = awakeIntervals.some((iv) => iv.startMin <= postNapIv.startMin && iv.endMin >= postNapIv.endMin);
		if (fitsPostNap) {
			awakeIntervals = subtractInterval(awakeIntervals, postNapIv);
			hobbyBlocks.push({
				id: `blk_postnap_reset_${date}`,
				date,
				startTime: formatClockMin(postNapIv.startMin),
				endTime: formatClockMin(postNapIv.endMin),
				startMin: postNapIv.startMin,
				endMin: postNapIv.endMin,
				durationMin: 10,
				type: "break",
				title: "Post-Nap Active Reset: Water & Walk (10m)",
				reason: "Stand up and move immediately on waking from midday rest",
			});
		}
	}

	// Post-dinner 15m walk to blunt postprandial drowsiness before evening blocks
	if (dipInfo.walkIv) {
		const walkIv = dipInfo.walkIv;
		const overlapsWalk = awakeIntervals.some((iv) => Math.min(iv.endMin, walkIv.endMin) - Math.max(iv.startMin, walkIv.startMin) >= 12);
		if (overlapsWalk) {
			awakeIntervals = subtractInterval(awakeIntervals, walkIv);
			hobbyBlocks.push({
				id: `blk_postmeal_${date}`,
				date,
				startTime: formatClockMin(walkIv.startMin),
				endTime: formatClockMin(walkIv.endMin),
				startMin: walkIv.startMin,
				endMin: walkIv.endMin,
				durationMin: walkIv.endMin - walkIv.startMin,
				type: "break",
				title: "Post-Meal Walk & Hydration (15m)",
				reason: "Light movement after dinner to prevent post-meal food coma",
			});
		}
	}

	// Bounded Gaming block scheduled strictly BEFORE bedtime cutoff (blue light / dopamine guard)
	const baseGameMin = config.lifestyle.gameBudgetMin ?? 0;
	const gameMin =
		baseGameMin >= 15
			? config.intensity === "healthy"
				? baseGameMin
				: config.intensity === "balanced"
					? Math.round(baseGameMin * 0.75)
					: Math.min(baseGameMin, 25)
			: 0;
	const gameCutoffMin = sleepCalc.tonightBedMin - Math.max(sleepCalc.windDownMin, config.lifestyle.gameCutoffBeforeBedMin ?? 90);
	if (gameMin >= 15 && awakeIntervals.length > 0) {
		const gIdx = [...awakeIntervals].reverse().findIndex((iv) => Math.min(iv.endMin, gameCutoffMin) - iv.startMin >= gameMin);
		if (gIdx >= 0) {
			const realIdx = awakeIntervals.length - 1 - gIdx;
			const iv = awakeIntervals[realIdx]!;
			const gStart = clamp(17 * 60 + 15, iv.startMin, Math.min(iv.endMin, gameCutoffMin) - gameMin);
			const gIv = { startMin: gStart, endMin: gStart + gameMin };
			awakeIntervals = subtractInterval(awakeIntervals, gIv);
			hobbyBlocks.push({
				id: `blk_game_${date}`,
				date,
				startTime: formatClockMin(gIv.startMin),
				endTime: formatClockMin(gIv.endMin),
				startMin: gIv.startMin,
				endMin: gIv.endMin,
				durationMin: gameMin,
				type: "hobby",
				title: `Decompress / Bounded Gaming (${gameMin}m)`,
				reason: `Hard stop before ${formatClockMin(gameCutoffMin)} to protect sleep`,
			});
		}
	}

	// Place wellness / hobby recharge block in post-dinner dip window (when enabled) or evening where longest gap >= pureHobbyMin
	const configuredHobbies = config.lifestyle.hobbies.filter((name) => config.lifestyle.hobbyPreferences?.[name]);
	const baseHobby = configuredHobbies.length ? configuredHobbies.reduce((sum, name) => sum + config.lifestyle.hobbyPreferences![name]!.dailyMin, 0) : config.lifestyle.dailyHobbyMin;
	const pureHobbyMin = Math.max(0, Math.min(baseCarve.hobbyMin - gameMin, config.intensity === "healthy" ? Math.max(baseHobby, band.minHobbyMin) : baseCarve.hobbyMin));
	if (configuredHobbies.length) {
		let remaining = pureHobbyMin;
		for (const name of configuredHobbies) {
			const pref = config.lifestyle.hobbyPreferences![name]!;
			const duration = Math.min(pref.dailyMin, remaining);
			if (duration < 5) continue;
			const preferred = pref.preferredWindow === "morning" ? 9 * 60 : pref.preferredWindow === "afternoon" ? 14 * 60 : 19 * 60 + 30;
			const candidates = awakeIntervals.map((iv, index) => ({ iv, index })).filter(({ iv }) => iv.endMin - iv.startMin >= duration).sort((a, b) => Math.abs(clamp(preferred, a.iv.startMin, a.iv.endMin - duration) - preferred) - Math.abs(clamp(preferred, b.iv.startMin, b.iv.endMin - duration) - preferred));
			const slot = candidates[0]; if (!slot) continue;
			const startMin = clamp(preferred, slot.iv.startMin, slot.iv.endMin - duration), endMin = startMin + duration;
			awakeIntervals = subtractInterval(awakeIntervals, { startMin, endMin });
			hobbyBlocks.push({ id: `blk_hobby_${date}_${hobbyBlocks.length}`, date, startTime: formatClockMin(startMin), endTime: formatClockMin(endMin), startMin, endMin, durationMin: duration, type: "hobby", title: name, reason: `Hobby budget ${pref.dailyMin}m · preferred ${pref.preferredWindow}` });
			remaining -= duration;
		}
	} else if (pureHobbyMin >= 20 && awakeIntervals.length > 0) {
		const preferredEveningStart = dipInfo.dipWindow ? dipInfo.dipWindow.startMin : 19 * 60 + 30;
		let chosenIdx = -1;
		let chosenStart = 0;
		for (let i = awakeIntervals.length - 1; i >= 0; i--) {
			const iv = awakeIntervals[i]!;
			if (iv.endMin - iv.startMin >= pureHobbyMin) {
				chosenIdx = i;
				chosenStart = clamp(preferredEveningStart, iv.startMin, iv.endMin - pureHobbyMin);
				if (iv.startMin >= 16 * 60 || i === awakeIntervals.length - 1) break;
			}
		}
		if (chosenIdx >= 0) {
			const hIv = { startMin: chosenStart, endMin: chosenStart + pureHobbyMin };
			awakeIntervals = subtractInterval(awakeIntervals, hIv);
			const hobbyList = config.lifestyle.hobbies.length > 0 ? config.lifestyle.hobbies.join(" / ") : "Recharge & Hobby";
			hobbyBlocks.push({
				id: `blk_hobby_${date}`,
				date,
				startTime: formatClockMin(hIv.startMin),
				endTime: formatClockMin(hIv.endMin),
				startMin: hIv.startMin,
				endMin: hIv.endMin,
				durationMin: pureHobbyMin,
				type: "hobby",
				title: `Hobby / Rest: ${hobbyList}`,
				reason: dipInfo.dipWindow
					? "Buffer post-dinner energy dip with active/offline recovery"
					: config.intensity === "healthy"
						? "Protected wellness recovery"
						: "Scheduled mental reset",
			});
		}
	}

	const focusBudgetAvailable = awakeIntervals.reduce((acc, iv) => acc + Math.max(0, iv.endMin - iv.startMin), 0);
	const candidates = collectSubjectCandidates(config, signals, {
		targetDate: date,
		rotationOffset: 0,
		carryoverBySubject: carryover.bySubject,
	});
	const { rawStudyBudget, minDailyMin, realism, examDeficitWarning } = computeRealisticStudyBudget(
		config,
		signals,
		date,
		dayOverride,
		focusBudgetAvailable,
		candidates,
		carryover.amortizedTodayMin,
	);
	const minDailyStudyHours = Math.round((Math.min(minDailyMin, limitToNow ? focusBudgetAvailable : minDailyMin) / 60) * 10) / 10;

	// If user manually edited today's timeline directly, honor customBlocks verbatim while keeping habit metrics + 7-day forecast intact
	const topMistakeRuleRaw = signals.mistakeHints?.recentRules[0];
	const topMistakeRule = topMistakeRuleRaw ? clipPreservingLatex(topMistakeRuleRaw, 180) : undefined;
	if (dayOverride?.customBlocks) {
		const customBeforeExams = limitToNow
			? clipPlannerBlocksFromNow(dayOverride.customBlocks, date, now).flatMap((block) => {
				if (block.startMin >= sleepCalc.tonightBedMin) return [];
				if (block.endMin <= sleepCalc.tonightBedMin) return [block];
				return [{ ...block, endMin: sleepCalc.tonightBedMin, endTime: formatClockMin(sleepCalc.tonightBedMin), durationMin: sleepCalc.tonightBedMin - block.startMin }];
			})
			: dayOverride.customBlocks;
		// Timetabled exams are commitments even when the user has a custom day.
		const examBlocks = fixedBlocks.filter((block) => block.id.startsWith("blk_exam_"));
		const customBlocks = [...customBeforeExams.filter((block) => !block.id.startsWith("blk_exam_")).flatMap((block) => {
			let intervals = [{ startMin: block.startMin, endMin: block.endMin }];
			for (const exam of examBlocks) intervals = subtractInterval(intervals, exam);
			return intervals.map((interval, index) => ({ ...block, id: index ? `${block.id}_after_exam_${index}` : block.id, startMin: interval.startMin, endMin: interval.endMin, startTime: formatClockMin(interval.startMin), endTime: formatClockMin(interval.endMin), durationMin: interval.endMin - interval.startMin }));
		}), ...examBlocks].sort((a, b) => a.startMin - b.startMin);
		const studyCustom = customBlocks.filter((b) => b.type === "study");
		const customMinutesBySubj = new Map<string, number>();
		for (const b of studyCustom) {
			const sName = b.subject || b.title;
			customMinutesBySubj.set(sName, (customMinutesBySubj.get(sName) ?? 0) + b.durationMin);
		}
		const plannedMin = studyCustom.reduce((a, b) => a + b.durationMin, 0);
		const customQuotas: DailyQuotaItem[] = [...customMinutesBySubj.entries()].map(([subj, mins], idx) => {
			const matched = candidates.find((c) => normalizeSubjectKey(c.subject) === normalizeSubjectKey(subj));
			return {
				id: matched?.milestone?.id ? `q_${matched.milestone.id}` : `q_custom_${idx}`,
				subject: subj,
				...(matched?.milestone ? { milestoneId: matched.milestone.id } : {}),
				targetMin: mins,
				urgencyScore: matched?.urgencyScore ?? 65,
				...(matched && matched.paceMultiplier !== 1 ? { paceMultiplier: matched.paceMultiplier } : {}),
				...(matched?.weaknessSummary ? { weaknessSummary: matched.weaknessSummary } : {}),
				checklist: matched
					? (idx === 0 && topMistakeRule
						? [...matched.checklist, { id: `chk_mistake_${date}`, text: `Mistake rule check: ${topMistakeRule}` }]
						: matched.checklist)
					: [{ id: `chk_custom_${date}_${idx}`, text: `Complete scheduled ${subj} session` }],
			};
		});
		return {
			date,
			generatedAt: new Date(now).toISOString(),
			engineUsed: "local",
			intensity: config.intensity,
			minDailyStudyHours: limitToNow ? Math.min(minDailyStudyHours, Math.round((plannedMin / 60) * 10) / 10) : minDailyStudyHours,
			plannedStudyHours: Math.round((plannedMin / 60) * 10) / 10,
			freeHoursTotal,
			recommendedBedtime: formatClockMin(sleepCalc.tonightBedMin),
			recommendedWakeTime: formatClockMin(sleepCalc.tonightWakeMin),
			todayWakeTime: formatClockMin(sleepCalc.todayWakeMin),
			sleepShiftAdvice: sleepCalc.advice,
			daysToSleepTarget: sleepCalc.daysToTarget,
			quotas: customQuotas,
			blocks: customBlocks,
			habitStrength: computeHabitStrengthSummary(config, date, sleepCalc.tonightBedMin),
			weeklyForecast: limitToNow
				? synchronizeTodayForecast(computeWeeklyForecast(config, signals, date, carryover.amortizedTodayMin), customQuotas, plannedMin, freeHoursTotal)
				: computeWeeklyForecast(config, signals, date, carryover.amortizedTodayMin),
			...(carryoverNote ? { carryoverNote } : {}),
			realismApplied: realism,
			...(dayOverride.focusSubjects && dayOverride.focusSubjects.length > 0 ? { activeFocusSubjects: dayOverride.focusSubjects } : {}),
			isCustomEdited: true,
		};
	}

	const quotasBySubject = allocateDailyQuotasBySubject(candidates, rawStudyBudget, focusBudgetAvailable, config.intensity);

	// Carve focus + break slots inside remaining awake intervals
	const blockLen = config.lifestyle.blockDurationMin;
	const breakLen = config.lifestyle.breakDurationMin;
	const rawSlots: Array<{ startMin: number; endMin: number; isPeak: boolean; rank: number }> = [];

	const resolvedPeak =
		config.lifestyle.sleep.peakFocusWindow === "auto"
			? sleepCalc.todayWakeMin >= 9 * 60
				? "afternoon"
				: "morning"
			: config.lifestyle.sleep.peakFocusWindow;
	const isPeakMin = (m: number) => {
		if (dipInfo.dipWindow && m >= dipInfo.dipWindow.startMin && m <= dipInfo.dipWindow.endMin) {
			return false;
		}
		const clock = m % 1440;
		if (resolvedPeak === "morning") return clock >= Math.max(sleepCalc.todayWakeMin + 30, 8 * 60) && clock <= 12 * 60;
		if (resolvedPeak === "afternoon") return clock >= 13 * 60 + 30 && clock <= 17 * 60 + 30;
		return clock >= 19 * 60 && clock <= 22 * 60 + 30;
	};

	for (const iv of awakeIntervals) {
		let cur = iv.startMin;
		while (cur + 25 <= iv.endMin) {
			const dur = Math.min(blockLen, iv.endMin - cur);
			if (dur < 25) break;
			rawSlots.push({
				startMin: cur,
				endMin: cur + dur,
				isPeak: isPeakMin(cur + dur / 2),
				rank: rawSlots.length,
			});
			cur += dur + breakLen;
		}
	}

	// Assign subjects round-robin by cognitive demand: peak slots get heavy/high-urgency subjects without consecutive single-subject streaks when avoidable
	const remainingQuota = new Map(quotasBySubject);
	const slotAssignments = new Array<SubjectCandidate | null>(rawSlots.length).fill(null);

	const sortedSlotOrder = [...rawSlots.keys()].sort((a, b) => {
		const sa = rawSlots[a]!;
		const sb = rawSlots[b]!;
		if (sa.isPeak !== sb.isPeak) return sa.isPeak ? -1 : 1;
		return sa.startMin - sb.startMin;
	});

	let lastAssignedSubject: string | null = null;
	for (const slotIdx of sortedSlotOrder) {
		const slot = rawSlots[slotIdx]!;
		const available = candidates.filter((c) => (remainingQuota.get(c.subject) ?? 0) >= 20);
		if (available.length === 0) break;

		const nonRepeating = available.filter((c) => c.subject !== lastAssignedSubject);
		const pool = nonRepeating.length > 0 ? nonRepeating : available;
		const inDip = Boolean(
			dipInfo.dipWindow && slot.endMin > dipInfo.dipWindow.startMin && slot.startMin < dipInfo.dipWindow.endMin,
		);
		pool.sort((a, b) => {
			if (inDip) {
				const da = a.cognitiveLoad === "light" ? 2 : a.cognitiveLoad === "medium" ? 1 : 0;
				const db = b.cognitiveLoad === "light" ? 2 : b.cognitiveLoad === "medium" ? 1 : 0;
				if (da !== db) return db - da;
			} else if (slot.isPeak) {
				const la = a.cognitiveLoad === "heavy" ? 2 : a.cognitiveLoad === "medium" ? 1 : 0;
				const lb = b.cognitiveLoad === "heavy" ? 2 : b.cognitiveLoad === "medium" ? 1 : 0;
				if (la !== lb) return lb - la;
			}
			return (remainingQuota.get(b.subject) ?? 0) + b.urgencyScore - ((remainingQuota.get(a.subject) ?? 0) + a.urgencyScore);
		});

		const picked = pool[0]!;
		slotAssignments[slotIdx] = picked;
		lastAssignedSubject = picked.subject;
		const slotDur = slot.endMin - slot.startMin;
		remainingQuota.set(picked.subject, Math.max(0, (remainingQuota.get(picked.subject) ?? 0) - slotDur));
	}

	const optimizedAssignments = optimizeSlotAssignments(rawSlots, slotAssignments, sleepCalc.tonightBedMin, dipInfo.dipWindow);
	const studyAndBreakBlocks: PlannedBlock[] = [];
	const actualAssignedBySubject = new Map<string, number>();

	for (let i = 0; i < rawSlots.length; i++) {
		const cand = optimizedAssignments[i];
		if (!cand) continue;
		const slot = rawSlots[i]!;
		const dur = slot.endMin - slot.startMin;
		actualAssignedBySubject.set(cand.subject, (actualAssignedBySubject.get(cand.subject) ?? 0) + dur);
		studyAndBreakBlocks.push({
			id: `blk_study_${date}_${i}`,
			date,
			startTime: formatClockMin(slot.startMin),
			endTime: formatClockMin(slot.endMin),
			startMin: slot.startMin,
			endMin: slot.endMin,
			durationMin: dur,
			type: "study",
			title: cand.milestone ? `${cand.subject} — ${cand.milestone.title}` : cand.subject,
			subject: cand.subject,
			...(cand.milestone ? { milestoneId: cand.milestone.id } : {}),
			cognitiveLoad: cand.cognitiveLoad,
			reason: `${cand.reason}${slot.isPeak ? " · Peak focus" : ""}`,
			strictSwitch: config.lifestyle.strictSwitchWarning && candidates.length >= 2,
			actionTopic: cand.checklist[0]?.text
				? `${cand.subject}: ${cand.checklist[0].text}`
				: cand.subject,
		});

		const nextSlot = rawSlots[i + 1];
		const nextCand = optimizedAssignments[i + 1];
		if (nextSlot && nextCand && nextSlot.startMin > slot.endMin) {
			studyAndBreakBlocks.push({
				id: `blk_brk_${date}_${i}`,
				date,
				startTime: formatClockMin(slot.endMin),
				endTime: formatClockMin(nextSlot.startMin),
				startMin: slot.endMin,
				endMin: nextSlot.startMin,
				durationMin: nextSlot.startMin - slot.endMin,
				type: "break",
				title: nextCand.subject !== cand.subject
					? `Break & Switch → ${nextCand.subject}`
					: "Short Stretch & Water Break",
				reason: nextCand.subject !== cand.subject ? "Strict subject switch checkpoint" : undefined,
			});
		}
	}

	const windDownBlock: PlannedBlock = {
		id: `blk_sleep_${date}`,
		date,
		startTime: formatClockMin(sleepCalc.tonightBedMin - sleepCalc.windDownMin),
		endTime: formatClockMin(sleepCalc.tonightBedMin),
		startMin: sleepCalc.tonightBedMin - sleepCalc.windDownMin,
		endMin: sleepCalc.tonightBedMin,
		durationMin: sleepCalc.windDownMin,
		type: "sleep",
		title: `Screen-off Wind-down → Sleep by ${formatClockMin(sleepCalc.tonightBedMin)}`,
		reason: sleepCalc.advice,
	};

	const rawBlocks = [...fixedBlocks, ...hobbyBlocks, ...studyAndBreakBlocks, windDownBlock];
	const allBlocks = (limitToNow ? clipPlannerBlocksFromNow(rawBlocks, date, now) : rawBlocks).sort(
		(a, b) => a.startMin - b.startMin,
	);
	const plannedMin = [...actualAssignedBySubject.values()].reduce((a, b) => a + b, 0);

	const quotas: DailyQuotaItem[] = candidates
		.filter((c) => (actualAssignedBySubject.get(c.subject) ?? 0) > 0)
		.map((c, idx) => ({
			id: `q_${c.milestone?.id ?? c.signal?.clusterId ?? idx}`,
			subject: c.subject,
			...(c.milestone ? { milestoneId: c.milestone.id } : {}),
			targetMin: actualAssignedBySubject.get(c.subject) ?? 30,
			urgencyScore: c.urgencyScore,
			...(c.paceMultiplier !== 1 ? { paceMultiplier: c.paceMultiplier } : {}),
			...(c.weaknessSummary ? { weaknessSummary: c.weaknessSummary } : {}),
			checklist:
				idx === 0 && topMistakeRule
					? [...c.checklist, { id: `chk_mistake_${date}`, text: `Mistake rule check: ${topMistakeRule}` }]
					: c.checklist,
		}));

	return {
		date,
		generatedAt: new Date(now).toISOString(),
		engineUsed: "local",
		intensity: config.intensity,
		minDailyStudyHours: limitToNow ? Math.min(minDailyStudyHours, Math.round((plannedMin / 60) * 10) / 10) : minDailyStudyHours,
		plannedStudyHours: Math.round((plannedMin / 60) * 10) / 10,
		freeHoursTotal,
		recommendedBedtime: formatClockMin(sleepCalc.tonightBedMin),
		recommendedWakeTime: formatClockMin(sleepCalc.tonightWakeMin),
		todayWakeTime: formatClockMin(sleepCalc.todayWakeMin),
		sleepShiftAdvice: sleepCalc.advice,
		daysToSleepTarget: sleepCalc.daysToTarget,
		quotas,
		blocks: allBlocks,
		habitStrength: computeHabitStrengthSummary(config, date, sleepCalc.tonightBedMin),
		weeklyForecast: limitToNow
			? synchronizeTodayForecast(computeWeeklyForecast(config, signals, date, carryover.amortizedTodayMin), quotas, plannedMin, freeHoursTotal)
			: computeWeeklyForecast(config, signals, date, carryover.amortizedTodayMin),
		...(carryoverNote ? { carryoverNote } : {}),
		...(examDeficitWarning ? { examDeficitWarning } : {}),
		realismApplied: realism,
		...(dayOverride?.focusSubjects && dayOverride.focusSubjects.length > 0 ? { activeFocusSubjects: dayOverride.focusSubjects } : {}),
	};
}

// ─── Token-Optimized LLM Digest & Merger ─────────────────────────────────────

/**
 * Compact JSON summary (~400-800 tokens) for AI Smart Planner mode.
 * Never leaks full transcripts — sends only structured priorities, graph
 * weakness counts, mistake patterns, fixed schedule occupancy, and sleep goals.
 */
export function buildCompactPlannerDigest(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	baselinePlan: DailyStudyPlan,
): Record<string, unknown> {
	const band = INTENSITY_STUDY_BOUNDS[config.intensity];
	const dayOverride = config.dayOverrides?.[signals.date];
	const sleepCalc = computeSleepAnchorForDate(config.lifestyle.sleep, config.logs, signals.date, config.intensity, dayOverride);
	const dipInfo = resolveEveningDipWindow(config, dayOverride, sleepCalc);
	const maxAllowedHours =
		dayOverride?.studyTargetHoursOverride !== undefined
			? dayOverride.studyTargetHoursOverride
			: Math.round((Math.min(baselinePlan.freeHoursTotal * 60 * 0.88, band.hardCeilingMin) / 60) * 10) / 10;

	return {
		date: signals.date,
		weekday: weekdayForDate(signals.date),
		intensityEnvelope: {
			mode: config.intensity,
			minStudyHours: Math.min(maxAllowedHours, baselinePlan.minDailyStudyHours),
			targetStudyHours: baselinePlan.plannedStudyHours,
			maxStudyHours: maxAllowedHours,
			minHobbyMin: band.minHobbyMin,
			maxSubjectsToday: resolveSubjectMaxDailyCap(config),
			strictRule: `You MUST stay within [${Math.min(maxAllowedHours, Math.round((band.minFloorMin / 60) * 10) / 10)}h, ${maxAllowedHours}h] total study for ${config.intensity} mode.`,
		},
		awakeWindow: {
			wake: baselinePlan.todayWakeTime,
			recommendedBedtime: baselinePlan.recommendedBedtime,
			preferredWakeTime: config.lifestyle.sleep.preferredWakeTime ?? baselinePlan.recommendedWakeTime,
			windDownBufferMin: sleepCalc.windDownMin,
			earlyWakingDetected: sleepCalc.earlyWakingDetected,
			actualLastSleepHours: sleepCalc.actualLastSleepHours,
			sleepShiftAdvice: sleepCalc.advice,
		},
		freeStudyWindows: baselinePlan.blocks
			.filter((b) => b.type === "study" || b.type === "break")
			.reduce((acc: string[], b) => {
				if (b.type === "study") acc.push(`${b.startTime}-${b.endTime}`);
				return acc;
			}, []),
		fixedEventsToday: baselinePlan.blocks
			.filter((b) => b.type === "fixed")
			.map((b) => `${b.startTime}-${b.endTime} ${b.title}`),
		lifestyleBalance: {
			hobbies: config.lifestyle.hobbies,
			hobbyPreferences: config.lifestyle.hobbyPreferences,
			dailyHobbyMin: config.lifestyle.dailyHobbyMin,
			gameBudgetMin: config.lifestyle.gameBudgetMin ?? 0,
			gameCutoffBeforeBedMin: config.lifestyle.gameCutoffBeforeBedMin ?? 90,
			postDinnerComaProtection: Boolean(config.lifestyle.sleep.postDinnerComaProtection),
			eveningDipWindow: dipInfo.dipWindow
				? `${formatClockMin(dipInfo.dipWindow.startMin)}-${formatClockMin(dipInfo.dipWindow.endMin)}`
				: null,
			wellnessGuardrail: config.lifestyle.wellnessGuardrail?.enabled
				? {
					enabled: true,
					weeklyTarget: config.lifestyle.wellnessGuardrail.targetWeeklyFreq ?? null,
					riskWindows: config.lifestyle.wellnessGuardrail.riskWindows ?? ["late_night"],
					replacementProtocol: config.lifestyle.wellnessGuardrail.replacementProtocol ?? "10m walk, cold water, offline book, phone outside bed",
					wakeUpAnchorProtocol: config.lifestyle.wellnessGuardrail.wakeUpAnchorProtocol ?? "Feet on floor <60s, cold water, leave bed before checking phone",
					deviceFrictionRules: config.lifestyle.wellnessGuardrail.deviceFrictionRules ?? [],
				}
				: null,
		},
		mutedSubjects: config.mutedSubjects ?? [],
		pinnedSubjects: config.pinnedSubjects ?? [],
		focusSubjectsToday: config.dayOverrides?.[signals.date]?.focusSubjects ?? [],
		realismFactor: config.realismFactor ?? signals.learningProfile?.realismFactor ?? 1.0,
		milestones: config.milestones.slice(0, 12).map((m) => ({
			id: m.id,
			kind: m.kind,
			title: m.title,
			subject: m.subject,
			dueDate: m.dueDate,
			daysLeft: daysBetweenDates(signals.date, m.dueDate),
			hoursRemaining: Math.max(0, Math.round((m.estimatedHours - m.completedHours) * 10) / 10),
			load: m.cognitiveLoad,
			openTopics: m.syllabusTopics.filter((t) => !t.done).slice(0, 5).map((t) => t.title),
			notesHint: m.notes ? clipPreservingLatex(m.notes, 160) : undefined,
		})),
		knowledgeSignals: signals.subjectSignals
			.filter((s) => !isSubjectMuted(s.label, config.mutedSubjects))
			.slice(0, 8)
			.map((s) => ({
				label: s.label,
				readinessPct: s.readinessPct,
				dueCount: s.dueCount,
				weakCount: s.weakCount,
				untrackedCount: s.untrackedCount,
				dueSample: s.dueSampleNames.slice(0, 3),
				weakSample: s.weakSampleNames.slice(0, 3),
				untrackedSample: (s.untrackedSampleNames ?? []).slice(0, 4),
				attachedFiles: (s.attachedFiles ?? []).slice(0, 3),
				activePlanTopics: (s.activePlanTopics ?? []).slice(0, 4),
				pendingProblems: (s.pendingProblems ?? []).slice(0, 3),
				...(s.sessionNotesPreview ? { sessionNotes: s.sessionNotesPreview } : {}),
			})),
		learningSpeed: signals.learningProfile?.sufficientData
			? {
				overallRetentionPct: signals.learningProfile.overallRetentionPct,
				overallSolveRatePct: signals.learningProfile.overallSolveRatePct,
				avgMinutesPerProblem: signals.learningProfile.avgMinutesPerProblem,
				sustainableDailyHours: signals.learningProfile.sustainableDailyHours,
			}
			: null,
		mistakes: signals.mistakeHints
			? {
				total: signals.mistakeHints.totalCount,
				pattern: signals.mistakeHints.recurringPattern,
				topRules: signals.mistakeHints.recentRules.slice(0, 3).map((r) => clipPreservingLatex(r, 170)),
			}
			: null,
		habitTrend: signals.habitTrend,
		localBaseline: {
			minDailyStudyHours: baselinePlan.minDailyStudyHours,
			plannedStudyHours: baselinePlan.plannedStudyHours,
			quotas: baselinePlan.quotas.map((q) => ({ subject: q.subject, targetMin: q.targetMin })),
		},
	};
}

export interface LlmCoachPlanPayload {
	coachSummary: string;
	minDailyStudyHours?: number;
	blocks?: Array<{
		startTime: string;
		endTime: string;
		type: "study" | "hobby" | "break";
		subject?: string;
		title: string;
		reason?: string;
		cognitiveLoad?: CognitiveLoad;
		actionTopic?: string;
	}>;
	quotas?: Array<{
		subject: string;
		targetMin: number;
		checklist: string[];
	}>;
}

/**
 * Safely merge validated LLM refinement onto `baselinePlan` without allowing
 * overlapping fixed events or bogus clock strings.
 */
export function applyLlmPlanOutput(
	baselinePlan: DailyStudyPlan,
	payload: LlmCoachPlanPayload,
	config: PlannerConfig,
	modelUsed: string,
	options: { now?: number } = {},
): DailyStudyPlan {
	const now = options.now;
	const limitToNow = now !== undefined && baselinePlan.date === localDateString(now);
	const clock = now === undefined ? null : new Date(now);
	const cutoff = limitToNow && clock ? clock.getHours() * 60 + clock.getMinutes() + (clock.getSeconds() || clock.getMilliseconds() ? 1 : 0) : 0;
	const staticBlocks = baselinePlan.blocks.filter((b) => b.type === "fixed" || b.type === "meal" || b.type === "sleep");
	const busy = staticBlocks.map((b) => ({ startMin: b.startMin, endMin: b.endMin }));
	const date = baselinePlan.date;
	const wakeMin = parseClockMin(baselinePlan.todayWakeTime) ?? 420;
	let bedtimeMin = parseClockMin(baselinePlan.recommendedBedtime) ?? 1440;
	if (bedtimeMin <= wakeMin) bedtimeMin += 1440;

	const toMonotonicMin = (hhmm: string): number | null => {
		const m = parseClockMin(hhmm);
		if (m === null) return null;
		return m < wakeMin - 60 ? m + 1440 : m;
	};

	const acceptedDynamic: PlannedBlock[] = [];
	let adjustedAiBlocks = false;
	const usedIntervals: TimeInterval[] = [...busy];
	const overlapsAny = (s: number, e: number) => usedIntervals.some((iv) => s < iv.endMin && e > iv.startMin);

	if (Array.isArray(payload.blocks)) {
		payload.blocks.slice(0, 24).forEach((raw, idx) => {
			const rawStart = parseClockMin(raw.startTime);
			const rawEnd = parseClockMin(raw.endTime);
			// A clock before wake can also be interpreted as tomorrow. Do not let
			// that normalization hide a collision with a same-day exam.
			if (rawStart !== null && rawEnd !== null && rawEnd > rawStart && staticBlocks.some((block) => block.id.startsWith("blk_exam_") && rawStart < block.endMin && rawEnd > block.startMin)) { adjustedAiBlocks = true; return; }
			const proposedStart = toMonotonicMin(raw.startTime);
			const e = toMonotonicMin(raw.endTime);
			if (proposedStart === null || e === null || e - proposedStart < 10 || e - proposedStart > 240) { adjustedAiBlocks = true; return; }
			if (limitToNow && (e <= cutoff || e > bedtimeMin)) { adjustedAiBlocks = true; return; }
			const s = limitToNow ? Math.max(proposedStart, cutoff) : proposedStart;
			if (s !== proposedStart) adjustedAiBlocks = true;
			if (s >= e || overlapsAny(s, e)) { adjustedAiBlocks = true; return; }
			const kind = raw.type === "hobby" || raw.type === "break" ? raw.type : "study";
			const title = String(raw.title || "").trim().slice(0, 100);
			if (!title) { adjustedAiBlocks = true; return; }
			const subj = typeof raw.subject === "string" ? raw.subject.trim().slice(0, 80) : undefined;
			const ms = subj ? config.milestones.find((m) => m.subject.toLowerCase() === subj.toLowerCase()) : undefined;
			usedIntervals.push({ startMin: s, endMin: e });
			acceptedDynamic.push({
				id: `blk_ai_${date}_${idx}`,
				date,
				startTime: formatClockMin(s),
				endTime: formatClockMin(e),
				startMin: s,
				endMin: e,
				durationMin: e - s,
				type: kind,
				title,
				...(subj ? { subject: subj } : {}),
				...(ms ? { milestoneId: ms.id } : {}),
				...(raw.cognitiveLoad ? { cognitiveLoad: raw.cognitiveLoad } : {}),
				...(raw.reason ? { reason: String(raw.reason).trim().slice(0, 140) } : {}),
				strictSwitch: kind === "study" && config.lifestyle.strictSwitchWarning,
				...(raw.actionTopic ? { actionTopic: String(raw.actionTopic).trim().slice(0, 120) } : {}),
			});
		});
	}

	const band = INTENSITY_STUDY_BOUNDS[config.intensity];
	const dayOverride = config.dayOverrides?.[date];
	const maxAllowedStudyMin =
		dayOverride?.studyTargetHoursOverride !== undefined
			? Math.min(Math.round(baselinePlan.freeHoursTotal * 60), Math.round(dayOverride.studyTargetHoursOverride * 60))
			: Math.min(Math.round(baselinePlan.freeHoursTotal * 60 * 0.88), band.hardCeilingMin);

	// Enforce intensity ceiling so Healthy never exceeds its cap or exceeds Balanced/Intensive
	const boundedDynamic: PlannedBlock[] = [];
	let runningStudyMin = 0;
	for (const blk of acceptedDynamic) {
		if (blk.type === "study") {
			if (limitToNow && runningStudyMin + blk.durationMin > maxAllowedStudyMin) {
				adjustedAiBlocks = true;
				const remaining = Math.max(0, maxAllowedStudyMin - runningStudyMin);
				if (remaining > 0) boundedDynamic.push({ ...blk, endMin: blk.startMin + remaining, endTime: formatClockMin(blk.startMin + remaining), durationMin: remaining });
				runningStudyMin += remaining;
				continue;
			}
			if (runningStudyMin + blk.durationMin > maxAllowedStudyMin + 10 && runningStudyMin >= band.minFloorMin) {
				adjustedAiBlocks = true;
				continue;
			}
			runningStudyMin += blk.durationMin;
		}
		boundedDynamic.push(blk);
	}

	const studyBlocks = boundedDynamic.filter((b) => b.type === "study");
	const finalBlocks = (limitToNow && Array.isArray(payload.blocks)) || studyBlocks.length >= 1
		? [...staticBlocks, ...boundedDynamic].sort((a, b) => a.startMin - b.startMin)
		: baselinePlan.blocks;

	const plannedStudyMin = finalBlocks
		.filter((b) => b.type === "study")
		.reduce((acc, b) => acc + b.durationMin, 0);
	const plannedStudyHours = Math.round((plannedStudyMin / 60) * 10) / 10;

	let finalQuotas = baselinePlan.quotas;
	if (Array.isArray(payload.quotas) && payload.quotas.length > 0) {
		const validQ = payload.quotas
			.filter((q) => typeof q.subject === "string" && q.subject.trim() && !isSubjectMuted(q.subject, config.mutedSubjects))
			.slice(0, resolveSubjectMaxDailyCap(config) + 1)
			.map((q, idx) => {
				const base = baselinePlan.quotas.find((b) => b.subject.toLowerCase() === q.subject.trim().toLowerCase());
				const checklist = Array.isArray(q.checklist) && q.checklist.length > 0
					? q.checklist.slice(0, 4).map((t, j) => ({ id: `chk_ai_${idx}_${j}`, text: clipPreservingLatex(String(t), 150) }))
					: base?.checklist ?? [{ id: `chk_ai_${idx}_0`, text: `Study ${q.subject.trim()}` }];
				return {
					id: base?.id ?? `q_ai_${idx}`,
					subject: q.subject.trim().slice(0, 80),
					...(base?.milestoneId ? { milestoneId: base.milestoneId } : {}),
					targetMin: clamp(Math.round(Number(q.targetMin) || 45), 20, maxAllowedStudyMin),
					urgencyScore: base?.urgencyScore ?? 60,
					...(base?.weaknessSummary ? { weaknessSummary: base.weaknessSummary } : {}),
					checklist,
				};
			});
		if (validQ.length > 0) finalQuotas = validQ;
	}

	// Synchronize quota minutes down proportionally if total study was clamped to the intensity ceiling
	const sumQuotaMin = finalQuotas.reduce((a, q) => a + q.targetMin, 0);
	if (sumQuotaMin > Math.max(plannedStudyMin, maxAllowedStudyMin) && sumQuotaMin > 0) {
		const ratio = Math.max(plannedStudyMin, Math.min(sumQuotaMin, maxAllowedStudyMin)) / sumQuotaMin;
		finalQuotas = finalQuotas.map((q) => ({
			...q,
			targetMin: Math.max(20, Math.round((q.targetMin * ratio) / 5) * 5),
		}));
	}

	if (limitToNow) {
		// Quotas describe accepted study blocks, not the model's unattainable proposal.
		const minutesBySubject = new Map<string, number>();
		for (const block of finalBlocks.filter((b) => b.type === "study")) {
			const subject = block.subject || block.title;
			minutesBySubject.set(subject, (minutesBySubject.get(subject) ?? 0) + block.durationMin);
		}
		finalQuotas = [...minutesBySubject].map(([subject, targetMin], idx) => {
			const existing = finalQuotas.find((q) => normalizeSubjectKey(q.subject) === normalizeSubjectKey(subject));
			return existing ? { ...existing, targetMin } : {
				id: `q_ai_scheduled_${idx}`, subject, targetMin, urgencyScore: 60,
				checklist: [{ id: `chk_ai_scheduled_${idx}`, text: `Study ${subject}` }],
			};
		});
	}

	const maxHoursCap = Math.round((maxAllowedStudyMin / 60) * 10) / 10;
	const minFloorHours = Math.min(maxHoursCap, Math.round((band.minFloorMin / 60) * 10) / 10);
	const rawLlmMin =
		typeof payload.minDailyStudyHours === "number" && Number.isFinite(payload.minDailyStudyHours)
			? payload.minDailyStudyHours
			: baselinePlan.minDailyStudyHours;
	const finalMinDailyStudyHours = clamp(Math.round(rawLlmMin * 10) / 10, Math.min(minFloorHours, baselinePlan.minDailyStudyHours), Math.max(minFloorHours, maxHoursCap));

	// Keep 7-Day Workload Forecast synchronized with AI Coach's hours & chosen subjects
	const scaleRatio = baselinePlan.plannedStudyHours > 0 ? clamp(plannedStudyHours / baselinePlan.plannedStudyHours, 0.72, 1.35) : 1;
	const syncedWeeklyForecast: WeeklyForecastDay[] | undefined = baselinePlan.weeklyForecast?.map((day, idx) => {
		if (idx === 0) {
			const daySubjects: WeeklyForecastSubjectQuota[] = finalQuotas.map((q) => ({
				subject: q.subject,
				plannedMinutes: q.targetMin,
				...(q.checklist[0]?.text ? { focusHint: q.checklist[0].text } : {}),
				...(q.milestoneId ? { isExamPriority: true } : {}),
			}));
			return {
				...day,
				plannedHours: plannedStudyHours,
				loadLevel: day.milestoneTitles.length > 0 || plannedStudyHours >= 5 ? "heavy" : plannedStudyHours >= 2.5 ? "moderate" : "light",
				subjects: daySubjects,
			};
		}
		const dayMaxHours = Math.round((Math.min(day.freeHours * 60 * 0.88, band.hardCeilingMin) / 60) * 10) / 10;
		const scaledHours = clamp(Math.round(day.plannedHours * scaleRatio * 10) / 10, 0.5, Math.max(0.5, dayMaxHours));
		const subjRatio = day.plannedHours > 0 ? scaledHours / day.plannedHours : 1;
		return {
			...day,
			plannedHours: scaledHours,
			loadLevel: day.milestoneTitles.length > 0 || scaledHours >= 5 ? "heavy" : scaledHours >= 2.5 ? "moderate" : "light",
			...(day.subjects
				? {
					subjects: day.subjects.map((s) => ({
						...s,
						plannedMinutes: Math.max(20, Math.round((s.plannedMinutes * subjRatio) / 5) * 5),
					})),
				}
				: {}),
		};
	});

	return {
		...baselinePlan,
		engineUsed: "llm",
		minDailyStudyHours: limitToNow ? Math.min(finalMinDailyStudyHours, plannedStudyHours) : finalMinDailyStudyHours,
		plannedStudyHours,
		quotas: finalQuotas,
		blocks: finalBlocks,
		...(syncedWeeklyForecast ? { weeklyForecast: syncedWeeklyForecast } : {}),
		coachSummary: limitToNow && adjustedAiBlocks
			? `Adjusted to available time. Scheduled: ${finalBlocks.map((b) => `${b.startTime}–${b.endTime} ${b.title}`).join("; ") || "no remaining blocks"}`.slice(0, 800)
			: String(payload.coachSummary || "").trim().slice(0, 800),
		modelUsed,
	};
}

// ─── Habit Check-in & Active Block Helpers ───────────────────────────────────

export interface HabitCheckInPatch {
	date?: string;
	/** Optional date for the returned view; does not change the date being recorded. */
	snapshotDate?: string;
	toggleBlockId?: string;
	toggleChecklistId?: string;
	addStudyMin?: { subject: string; minutes: number; milestoneId?: string };
	actualBedtime?: string | null;
	actualWakeTime?: string | null;
	sleepQuality?: 1 | 2 | 3 | 4 | 5;
	wokeEarlyUnintended?: boolean;
	energyScore?: 1 | 2 | 3 | 4 | 5;
	foodComaHitToday?: boolean;
	urgesSurfed?: number;
	incrementUrgesSurfed?: boolean;
	urgeTriggerWindows?: string[];
	addUrgeTrigger?: string;
	hobbyDone?: boolean;
	mealsOk?: boolean;
	sleepOnTarget?: boolean;
	note?: string;
	journalText?: string;
	actualEntries?: JournalActivityEntry[];
	habitCounts?: DailyHabitLog["habitCounts"];
}

export function applyHabitCheckIn(
	config: PlannerConfig,
	patch: HabitCheckInPatch,
	now = Date.now(),
): PlannerConfig {
	const date = isValidDateString(patch.date) ? patch.date.trim() : localDateString(now);
	const existing = config.logs[date] ?? {
		date,
		completedBlockIds: [],
		completedChecklistIds: [],
		loggedStudyMinBySubject: {},
		hobbyDone: false,
		mealsOk: false,
	};

	const completedBlockIds = new Set(existing.completedBlockIds);
	const completedChecklistIds = new Set(existing.completedChecklistIds);
	const loggedStudyMinBySubject = { ...existing.loggedStudyMinBySubject };
	let hobbyDone = existing.hobbyDone;
	let milestones = config.milestones;

	if (patch.toggleBlockId) {
		const block = config.plans[date]?.blocks.find((b) => b.id === patch.toggleBlockId);
		if (completedBlockIds.has(patch.toggleBlockId)) {
			completedBlockIds.delete(patch.toggleBlockId);
			if (block?.type === "study" && block.subject) {
				loggedStudyMinBySubject[block.subject] = Math.max(
					0,
					(loggedStudyMinBySubject[block.subject] ?? 0) - block.durationMin,
				);
			}
			if (block?.milestoneId) {
				milestones = milestones.map((m) =>
					m.id === block.milestoneId
						? { ...m, completedHours: Math.max(0, Math.round((m.completedHours - block.durationMin / 60) * 100) / 100) }
						: m,
				);
			}
		} else {
			completedBlockIds.add(patch.toggleBlockId);
			if (block?.type === "study" && block.subject) {
				loggedStudyMinBySubject[block.subject] = (loggedStudyMinBySubject[block.subject] ?? 0) + block.durationMin;
			}
			if (block?.type === "hobby") hobbyDone = true;
			if (block?.milestoneId) {
				milestones = milestones.map((m) =>
					m.id === block.milestoneId
						? { ...m, completedHours: Math.min(m.estimatedHours, Math.round((m.completedHours + block.durationMin / 60) * 100) / 100) }
						: m,
				);
			}
		}
	}

	if (patch.toggleChecklistId) {
		if (completedChecklistIds.has(patch.toggleChecklistId)) {
			completedChecklistIds.delete(patch.toggleChecklistId);
		} else {
			completedChecklistIds.add(patch.toggleChecklistId);
		}
	}

	if (patch.addStudyMin && patch.addStudyMin.subject.trim() && patch.addStudyMin.minutes > 0) {
		const subj = patch.addStudyMin.subject.trim().slice(0, 80);
		const addMin = clamp(Math.round(patch.addStudyMin.minutes), 1, 600);
		loggedStudyMinBySubject[subj] = (loggedStudyMinBySubject[subj] ?? 0) + addMin;
		const msId = patch.addStudyMin.milestoneId;
		const subjLower = subj.toLowerCase();
		milestones = milestones.map((m) =>
			(msId && m.id === msId) || (!msId && m.subject.toLowerCase() === subjLower)
				? {
					...m,
					completedHours: Math.min(m.estimatedHours, Math.round((m.completedHours + addMin / 60) * 100) / 100),
				}
				: m,
		);
	}

	const mergedTriggerWindows = (() => {
		if (patch.urgeTriggerWindows !== undefined) return sanitizeStringArray(patch.urgeTriggerWindows, 12, 40);
		const cur = existing.urgeTriggerWindows ? [...existing.urgeTriggerWindows] : [];
		if (typeof patch.addUrgeTrigger === "string" && patch.addUrgeTrigger.trim()) {
			const clean = patch.addUrgeTrigger.trim().slice(0, 40);
			if (!cur.includes(clean)) cur.push(clean);
		}
		return cur.slice(0, 12);
	})();
	const nextUrgesSurfed =
		patch.urgesSurfed !== undefined
			? clamp(Math.round(patch.urgesSurfed), 0, 100)
			: patch.incrementUrgesSurfed
				? clamp((existing.urgesSurfed ?? 0) + 1, 0, 100)
				: existing.urgesSurfed;

	const nextLog: DailyHabitLog = {
		...existing,
		...(patch.actualBedtime === null ? { actualBedtime: undefined } : patch.actualBedtime !== undefined && parseClockMin(patch.actualBedtime) !== null
			? { actualBedtime: normalizeClockString(patch.actualBedtime, existing.actualBedtime ?? "23:30") }
			: {}),
		...(patch.actualWakeTime === null ? { actualWakeTime: undefined } : patch.actualWakeTime !== undefined && parseClockMin(patch.actualWakeTime) !== null
			? { actualWakeTime: normalizeClockString(patch.actualWakeTime, existing.actualWakeTime ?? "07:00") }
			: {}),
		...(patch.sleepQuality !== undefined ? { sleepQuality: patch.sleepQuality } : {}),
		...(patch.wokeEarlyUnintended !== undefined ? { wokeEarlyUnintended: patch.wokeEarlyUnintended } : {}),
		...(patch.energyScore !== undefined ? { energyScore: patch.energyScore } : {}),
		...(patch.foodComaHitToday !== undefined ? { foodComaHitToday: patch.foodComaHitToday } : {}),
		...(nextUrgesSurfed !== undefined ? { urgesSurfed: nextUrgesSurfed } : {}),
		...(mergedTriggerWindows.length > 0 || patch.urgeTriggerWindows !== undefined
			? { urgeTriggerWindows: mergedTriggerWindows }
			: {}),
		...(patch.hobbyDone !== undefined ? { hobbyDone: patch.hobbyDone } : { hobbyDone }),
		...(patch.mealsOk !== undefined ? { mealsOk: patch.mealsOk } : {}),
		...(patch.sleepOnTarget !== undefined ? { sleepOnTarget: patch.sleepOnTarget } : {}),
		...(patch.note !== undefined ? { note: patch.note.trim().slice(0, 4000) } : {}),
		...(patch.journalText !== undefined ? { journalText: patch.journalText.trim().slice(0, 4000) } : {}),
		...(patch.actualEntries !== undefined ? { actualEntries: sanitizeActualEntries(patch.actualEntries, date) } : {}),
		...(patch.habitCounts !== undefined ? { habitCounts: patch.habitCounts } : {}),
		completedBlockIds: [...completedBlockIds],
		completedChecklistIds: [...completedChecklistIds],
		loggedStudyMinBySubject,
		updatedAt: new Date(now).toISOString(),
	};

	const mergedLogs = sanitizeLogs({ ...config.logs, [date]: nextLog });
	const updatedConfig: PlannerConfig = {
		...config,
		milestones,
		logs: mergedLogs,
		updatedAt: new Date(now).toISOString(),
	};
	const existingPlan = config.plans[date];
	if (existingPlan) {
		const sleepCalc = computeSleepAnchorForDate(updatedConfig.lifestyle.sleep, mergedLogs, date, updatedConfig.intensity);
		updatedConfig.plans = {
			...config.plans,
			[date]: {
				...existingPlan,
				habitStrength: computeHabitStrengthSummary(updatedConfig, date, sleepCalc.tonightBedMin),
			},
		};
	}
	return updatedConfig;
}

export interface ActiveBlockStatus {
	currentBlock: PlannedBlock | null;
	nextStudyBlock: PlannedBlock | null;
	recentlyEndedBlock: PlannedBlock | null;
	shouldPromptSwitch: boolean;
	preSwitchWarning: boolean;
	minutesRemaining: number;
}

/** Determine live active/just-ended block for soft subject-switching discipline. */
export function resolveActiveBlockStatus(
	plan: DailyStudyPlan | null | undefined,
	log: DailyHabitLog | undefined,
	now = Date.now(),
): ActiveBlockStatus {
	if (!plan || plan.blocks.length === 0) {
		return {
			currentBlock: null,
			nextStudyBlock: null,
			recentlyEndedBlock: null,
			shouldPromptSwitch: false,
			preSwitchWarning: false,
			minutesRemaining: 0,
		};
	}
	const dt = new Date(now);
	const todayStr = localDateString(now);
	let nowMin = dt.getHours() * 60 + dt.getMinutes();
	if (plan.date < todayStr) nowMin += 1440; // past-midnight spillover of yesterday's late schedule

	const doneSet = new Set(log?.completedBlockIds ?? []);
	const currentBlock = plan.blocks.find((b) => nowMin >= b.startMin && nowMin < b.endMin) ?? null;
	const nextStudyBlock = plan.blocks.find((b) => b.type === "study" && b.startMin >= nowMin && !doneSet.has(b.id)) ?? null;
	const recentlyEndedBlock =
		plan.blocks
			.filter((b) => b.type === "study" && !doneSet.has(b.id) && b.endMin <= nowMin && nowMin - b.endMin <= 20)
			.at(-1) ?? null;

	const minutesRemaining = currentBlock ? Math.max(0, currentBlock.endMin - nowMin) : 0;
	const preSwitchWarning = Boolean(
		currentBlock?.type === "study" &&
		currentBlock.strictSwitch &&
		minutesRemaining > 0 &&
		minutesRemaining <= 2 &&
		nextStudyBlock &&
		nextStudyBlock.subject !== currentBlock.subject,
	);
	const shouldPromptSwitch = Boolean(
		(recentlyEndedBlock && recentlyEndedBlock.strictSwitch && nextStudyBlock && nextStudyBlock.subject !== recentlyEndedBlock.subject) ||
		(currentBlock?.type === "break" && nextStudyBlock),
	);

	return {
		currentBlock,
		nextStudyBlock,
		recentlyEndedBlock,
		shouldPromptSwitch,
		preSwitchWarning,
		minutesRemaining,
	};
}

const ICS_DAY_MAP: Record<string, Weekday> = {
	MO: "mon",
	TU: "tue",
	WE: "wed",
	TH: "thu",
	FR: "fri",
	SA: "sat",
	SU: "sun",
};

/**
 * Zero-token RFC 5545 `.ics` calendar parser (Obsidian Day Planner / UniCalendar inspired):
 * extracts recurring classes/events (RRULE BYDAY or DTSTART weekday) into weekly fixed events.
 */
export function parseIcsWeeklyEvents(icsText: string): FixedWeeklyEvent[] {
	const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
	const eventPattern = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
	const out: FixedWeeklyEvent[] = [];
	const dedup = new Set<string>();
	let match: RegExpExecArray | null;
	let idx = 0;

	while ((match = eventPattern.exec(unfolded)) !== null) {
		const block = match[1] ?? "";
		const getField = (name: string): string => {
			const re = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "im");
			const m = re.exec(block);
			return m?.[1]?.trim() ?? "";
		};

		const rawSummary = getField("SUMMARY")
			.replace(/\\n/gi, " ")
			.replace(/\\([,;\\])/g, "$1")
			.trim()
			.slice(0, 80);
		if (!rawSummary) continue;

		const dtStart = getField("DTSTART");
		const dtEnd = getField("DTEND");
		const startClockMatch = /T(\d{2})(\d{2})/.exec(dtStart);
		const endClockMatch = /T(\d{2})(\d{2})/.exec(dtEnd);
		if (!startClockMatch || !endClockMatch) continue;

		const startMin = Number(startClockMatch[1]) * 60 + Number(startClockMatch[2]);
		const endMin = Number(endClockMatch[1]) * 60 + Number(endClockMatch[2]);
		if (startMin >= endMin || endMin > 24 * 60) continue;

		const startTime = formatClockMin(startMin);
		const endTime = formatClockMin(Math.min(endMin, 23 * 60 + 59));

		const rrule = getField("RRULE");
		const byDayMatch = /BYDAY=([A-Z,]+)/i.exec(rrule);
		const days: Weekday[] = [];
		if (byDayMatch) {
			for (const tok of byDayMatch[1]!.toUpperCase().split(",")) {
				const code = tok.replace(/[^A-Z]/g, "").slice(-2);
				const mapped = ICS_DAY_MAP[code];
				if (mapped && !days.includes(mapped)) days.push(mapped);
			}
		} else {
			const dateMatch = /(\d{4})(\d{2})(\d{2})/.exec(dtStart);
			if (dateMatch) {
				days.push(weekdayForDate(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`));
			}
		}
		if (days.length === 0) continue;

		const categories = getField("CATEGORIES");
		const catHay = `${rawSummary} ${categories}`;
		const category: FixedEventCategory = /clb|club/i.test(catHay)
			? "club"
			: /làm|work|intern/i.test(catHay)
				? "work"
				: /commute|bus|travel/i.test(catHay)
					? "commute"
					: "class";

		for (const day of days) {
			const key = `${day}|${startTime}|${endTime}|${rawSummary.toLowerCase()}`;
			if (dedup.has(key)) continue;
			dedup.add(key);
			out.push({
				id: slugId("ics", `${day}_${startMin}_${rawSummary}`, idx++),
				dayOfWeek: day,
				startTime,
				endTime,
				title: rawSummary,
				category,
			});
		}
	}

	return sanitizeFixedEvents(out);
}

/**
 * Zero-token local outline/syllabus parser: extracts topic bullets and hour hints
 * like "(4h)", "4.5 hours", "6 giờ", or "3 tiết".
 */
export function parseLocalSyllabusOutline(rawText: string): { estimatedHours: number; syllabusTopics: SyllabusTopic[] } {
	const lines = rawText.normalize("NFC").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const hourHintRe = /(?:\(\s*)?(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?|gi[ờo]|ti[ếe]t)(?:\s*\))?/i;
	const syllabusTopics: SyllabusTopic[] = [];

	for (let i = 0; i < lines.length && syllabusTopics.length < 20; i++) {
		const raw = lines[i]!;
		if (/^[-=*_]{3,}$/.test(raw)) continue;

		// Recognize Notion/CSV rows like "10.21,No,,△,🟠" or "Tên công việc,Chi tiết,Hoàn thành..."
		if (raw.includes(",")) {
			const cols = raw.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
			const first = (cols[0] ?? "").toLowerCase();
			if (["bài", "tên công việc", "main goal", "title", "task"].includes(first)) continue;
			const joinedFlags = cols.slice(1).join(" ").toLowerCase();
			if (/\byes\b|\b✓\b|hoàn thành/.test(joinedFlags) && !/\bno\b|chưa/.test(joinedFlags)) {
				continue; // Skip already-completed Notion tracker rows
			}
			const label = cols.filter((c, idx) => c && (idx === 0 || idx === 1 || idx === 3)).slice(0, 3).join(" — ").slice(0, 100);
			if (label) {
				const est = raw.includes("🔴") ? 2.5 : raw.includes("🟠") ? 2 : 1.5;
				syllabusTopics.push({ id: slugId("top", label, syllabusTopics.length), title: label, estHours: est, done: false });
				continue;
			}
		}

		const stripped = raw.replace(/^(?:[-*•#]+|\d+[.)]+)\s*/, "").trim();
		if (!stripped) continue;

		let estHours = 3;
		const hm = hourHintRe.exec(stripped);
		if (hm) {
			const num = Number(hm[1]!.replace(",", "."));
			const unit = hm[2]!.toLowerCase();
			if (Number.isFinite(num) && num > 0) {
				estHours = unit.startsWith("ti") ? Math.round(num * 0.75 * 10) / 10 : Math.round(num * 10) / 10;
			}
		}

		let title = hm ? stripped.replace(hm[0], "") : stripped;
		title = title
			.replace(/\(\s*\)/g, "")
			.replace(/^[\s:,\-–—|]+|[\s:,\-–—|]+$/g, "")
			.replace(/\s{2,}/g, " ")
			.trim()
			.slice(0, 100);
		if (!title) continue;

		syllabusTopics.push({
			id: slugId("top", title, syllabusTopics.length),
			title,
			estHours: clamp(estHours, 0.5, 100),
			done: false,
		});
	}

	if (syllabusTopics.length === 0 && rawText.trim()) {
		syllabusTopics.push({
			id: "top_core_0",
			title: rawText.trim().slice(0, 100),
			estHours: 3,
			done: false,
		});
	}

	const sum = syllabusTopics.reduce((acc, t) => acc + t.estHours, 0);
	return {
		estimatedHours: Math.max(1, Math.round(sum * 10) / 10),
		syllabusTopics,
	};
}

const DAY_TOKEN_MAP: Record<string, Weekday> = {
	mon: "mon", monday: "mon", t2: "mon", "thứ 2": "mon", "thu 2": "mon",
	tue: "tue", tuesday: "tue", t3: "tue", "thứ 3": "tue", "thu 3": "tue",
	wed: "wed", wednesday: "wed", t4: "wed", "thứ 4": "wed", "thu 4": "wed",
	thu: "thu", thursday: "thu", t5: "thu", "thứ 5": "thu", "thu 5": "thu",
	fri: "fri", friday: "fri", t6: "fri", "thứ 6": "fri", "thu 6": "fri",
	sat: "sat", saturday: "sat", t7: "sat", "thứ 7": "sat", "thu 7": "sat",
	sun: "sun", sunday: "sun", cn: "sun", "chủ nhật": "sun", "chu nhat": "sun",
};

/**
 * Best-effort 0-token local fallback parser for `.ics` calendars OR simple line-based schedules
 * like "T2 07:30-09:30 Giải tích" or "Wed 14h-16h30 Algorithms".
 */
export function parseSimpleWeeklyText(rawText: string): FixedWeeklyEvent[] {
	if (/BEGIN:V(?:CALENDAR|EVENT)/i.test(rawText)) {
		return parseIcsWeeklyEvents(rawText);
	}
	const lines = rawText.normalize("NFC").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const out: FixedWeeklyEvent[] = [];
	const dayPattern = /\b(monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat|sunday|sun|th[ứu]\s*[2-7]|t[2-7]|ch[ủu]\s*nh[ậa]t|cn)\b/i;
	const timeRangePattern = /(\d{1,2})(?:[:h](\d{1,2})?)?\s*(?:-|to|–|—|~|>)\s*(\d{1,2})(?:[:h](\d{1,2})?)?/i;

	lines.forEach((line, idx) => {
		const dm = dayPattern.exec(line);
		const tm = timeRangePattern.exec(line);
		if (!dm || !tm) return;
		const day = DAY_TOKEN_MAP[dm[1]!.toLowerCase().replace(/\s+/g, " ")];
		if (!day) return;
		const sh = Number(tm[1]);
		const sm = Number(tm[2] ?? "0");
		const eh = Number(tm[3]);
		const em = Number(tm[4] ?? "0");
		const startMin = sh * 60 + sm;
		const endMin = eh * 60 + em;
		if (sh > 23 || eh > 23 || sm > 59 || em > 59 || endMin <= startMin) return;

		let title = line
			.replace(dm[0], "")
			.replace(tm[0], "")
			.replace(/^[\s:,\-–—|]+|[\s:,\-–—|]+$/g, "")
			.trim()
			.slice(0, 80);
		if (!title) title = "Scheduled class";

		out.push({
			id: slugId("fix", `${day}_${startMin}_${title}`, idx),
			dayOfWeek: day,
			startTime: formatClockMin(startMin),
			endTime: formatClockMin(endMin),
			title,
			category: /clb|club/i.test(title) ? "club" : /làm|work|intern/i.test(title) ? "work" : "class",
		});
	});
	return sanitizeFixedEvents(out);
}

export interface CalendarGridCell {
	date: string;
	dayNum: number;
	inMonth: boolean;
}

/** Build a Mon–Sun aligned month grid (35 or 42 cells) for Month & Year calendar views. */
export function buildMonthGridDates(year: number, monthIndex0: number): CalendarGridCell[] {
	const firstDayUtc = new Date(Date.UTC(year, monthIndex0, 1));
	const mondayOffset = (firstDayUtc.getUTCDay() + 6) % 7; // Mon=0..Sun=6
	const daysInMonth = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
	const totalCells = mondayOffset + daysInMonth > 35 ? 42 : 35;
	const startDateStr = `${year}-${String(monthIndex0 + 1).padStart(2, "0")}-01`;
	const out: CalendarGridCell[] = [];
	for (let i = 0; i < totalCells; i++) {
		const delta = i - mondayOffset;
		const date = addDaysToDate(startDateStr, delta);
		out.push({
			date,
			dayNum: Number(date.slice(8, 10)),
			inMonth: delta >= 0 && delta < daysInMonth,
		});
	}
	return out;
}

// ─── Personalized Workload Calibration ("Lực học") & 24h Journal Evaluator ───

export interface PersonalizedWorkloadEstimate {
	estimatedHours: number;
	recommendedDailyHours: number;
	paceFactorApplied: number;
	confidence: "personalized" | "baseline";
	sufficiencyReason: string;
	breakdownReasons: string[];
	topicEstimates?: SyllabusTopic[];
}

/**
 * Compute realistic `estimatedHours` for an exam/milestone from the student's actual
 * measured learning speed (FSRS stability/retention, Practice solve rate & minutes/problem,
 * Teach session pace, Graph weak/untracked counts), transparently reporting when data is still baseline.
 */
export function computePersonalizedMilestoneEstimate(opts: {
	title: string;
	subject: string;
	kind?: StudyMilestone["kind"];
	dueDate?: string;
	todayDate?: string;
	baseHours?: number;
	syllabusTopics?: readonly SyllabusTopic[];
	clusterIds?: readonly string[];
	signals: PlannerPersonalSignals;
}): PersonalizedWorkloadEstimate {
	const today = opts.todayDate ?? opts.signals.date;
	const profile = opts.signals.learningProfile;
	const matchedSignal = opts.signals.subjectSignals.find(
		(s) =>
			(opts.clusterIds?.includes(s.clusterId) ?? false) ||
			normalizeSubjectKey(s.label) === normalizeSubjectKey(opts.subject) ||
			normalizeSubjectKey(s.label).includes(normalizeSubjectKey(opts.subject || opts.title)),
	);
	const subjectMetrics =
		findLearningMetricsForSubject(opts.subject, profile) ??
		findLearningMetricsForSubject(opts.title, profile) ??
		(matchedSignal ? findLearningMetricsForSubject(matchedSignal.label, profile) : undefined);

	const topics = opts.syllabusTopics ? [...opts.syllabusTopics] : [];
	const rawTopicSum = topics.reduce((a, t) => a + t.estHours, 0);
	const baseHours =
		opts.baseHours && opts.baseHours > 0
			? opts.baseHours
			: rawTopicSum > 0
				? rawTopicSum
				: opts.kind === "competition"
					? 28
					: opts.kind === "project"
						? 18
						: 14;

	const reasons: string[] = [];
	let graphGapHours = 0;
	if (matchedSignal) {
		const untrackedAdd = matchedSignal.untrackedCount * 0.45;
		const weakAdd = matchedSignal.weakCount * 0.85;
		const dueAdd = matchedSignal.dueCount * 0.2;
		graphGapHours = Math.round((untrackedAdd + weakAdd + dueAdd) * 10) / 10;
		if (graphGapHours >= 0.5) {
			reasons.push(
				`Graph gaps (${matchedSignal.label}): ${matchedSignal.untrackedCount} untracked · ${matchedSignal.weakCount} weak · ${matchedSignal.dueCount} FSRS due (+${graphGapHours}h)`,
			);
		}
	}

	let paceFactor = 1.0;
	const sufficient = Boolean(profile?.sufficientData);
	if (sufficient && subjectMetrics && (subjectMetrics.fsrsReviews >= 4 || subjectMetrics.practiceSessions >= 2)) {
		paceFactor = subjectMetrics.paceFactor;
		const metricParts: string[] = [];
		if (subjectMetrics.retentionRatePct !== null) metricParts.push(`FSRS retention ${subjectMetrics.retentionRatePct}%`);
		if (subjectMetrics.practiceSolveRatePct !== null) metricParts.push(`Practice solve ${subjectMetrics.practiceSolveRatePct}%`);
		if (subjectMetrics.avgMinutesPerProblem !== null) metricParts.push(`~${subjectMetrics.avgMinutesPerProblem}m/problem`);
		reasons.push(`Subject learning speed (${subjectMetrics.subject}): ${metricParts.join(", ")} → ${paceFactor}× pace`);
	} else if (sufficient && profile) {
		const globalSolve = profile.overallSolveRatePct ?? 70;
		const globalRet = profile.overallRetentionPct ?? 75;
		const derived = 1 + (75 - globalSolve) * 0.004 + (80 - globalRet) * 0.003;
		paceFactor = clamp(Math.round(derived * 100) / 100, 0.8, 1.45);
		reasons.push(
			`Overall student profile (${profile.totalFsrsReviews} FSRS reviews, solve rate ${profile.overallSolveRatePct ?? "—"}%, retention ${profile.overallRetentionPct ?? "—"}%) → ${paceFactor}× pace`,
		);
	} else {
		reasons.push(profile?.sufficiencyReason ?? "Baseline estimate used — log 2+ days or complete more Practice/FSRS reviews to unlock personalized pace.");
	}

	const calibratedHours = Math.max(2, Math.round((baseHours * 0.8 + graphGapHours + baseHours * 0.2) * paceFactor * 2) / 2);
	const daysLeft = opts.dueDate ? Math.max(1, daysBetweenDates(today, opts.dueDate)) : 14;
	const recommendedDailyHours = Math.max(0.5, Math.round((calibratedHours / daysLeft) * 10) / 10);

	const adjustedTopics =
		topics.length > 0
			? topics.map((t) => ({
				...t,
				estHours: Math.max(0.5, Math.round(t.estHours * paceFactor * 2) / 2),
			}))
			: undefined;

	return {
		estimatedHours: calibratedHours,
		recommendedDailyHours,
		paceFactorApplied: Math.round(paceFactor * 100) / 100,
		confidence: sufficient ? "personalized" : "baseline",
		sufficiencyReason: profile?.sufficiencyReason ?? "Need more FSRS reviews & logged days",
		breakdownReasons: reasons,
		...(adjustedTopics ? { topicEstimates: adjustedTopics } : {}),
	};
}

const SENSITIVE_JOURNAL_RE =
	/\b(?:thu\s*dam|quay\s*tay|soc\s*lo|phim\s*(?:sex|18\+|nguoi\s*lon|nong)|xem\s*(?:sex|porn|hentai|jav|18\+)|porn(?:ography)?|hentai|masturbat(?:e|ed|es|ing|ion)|fap(?:ping|ped)?|no\s*fap|pmo|fetish(?:es)?|erotica|orgasm(?:s)?|jerk(?:ed|ing)?\s*off|libido\s*(?:spike|cao|tang)|nung)\b/gi;

/**
 * Redacts explicit/intimate terms from journal text before showing in history previews
 * or sending to cloud AI models while preserving timestamps and behavioral meaning.
 */
export function redactSensitiveJournalText(text: string): string {
	if (!text) return "";
	let normalized = "";
	const offsets: Array<{ start: number; end: number }> = [];
	for (let index = 0; index < text.length;) {
		const character = String.fromCodePoint(text.codePointAt(index)!);
		const end = index + character.length;
		const plain = character.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d");
		normalized += plain;
		for (let unit = 0; unit < plain.length; unit++) offsets.push({ start: index, end });
		index = end;
	}
	let result = "", cursor = 0;
	SENSITIVE_JOURNAL_RE.lastIndex = 0;
	for (const match of normalized.matchAll(SENSITIVE_JOURNAL_RE)) {
		const first = offsets[match.index], last = offsets[match.index + match[0].length - 1];
		if (!first || !last) continue;
		result += text.slice(cursor, first.start) + "[private]"; cursor = last.end;
	}
	return result + text.slice(cursor);
}

function classifyJournalLine(text: string, knownSubjects: readonly string[]): {
	category: JournalActivityCategory;
	subject?: string;
} {
	const norm = normalizeSubjectKey(text);
	let matchedSubject: string | undefined;
	let bestLen = 0;
	for (const sub of knownSubjects) {
		const nk = normalizeSubjectKey(sub);
		if (!nk || nk.length < 2) continue;
		if ((norm.includes(nk) || nk.split(" ").filter((w) => w.length >= 3).every((w) => norm.includes(w))) && nk.length > bestLen) {
			matchedSubject = sub;
			bestLen = nk.length;
		}
	}

	if (/\b(personal reset|reset ca nhan|personal break|nghi ca nhan)\b/.test(norm)) {
		return { category: "rest" };
	}
	if (/\b(thu dam|quay tay|soc lo|xem sex|phim sex|porn|hentai|fetish|masturbat|jerk off|pmo)\b/.test(norm)) {
		return { category: "distraction" };
	}
	if (/\b(khong hoc|chua hoc|chua on|doc linh tinh|ngoi choi|luot linh tinh|khong tap trung|vo dinh)\b/.test(norm)) {
		return { category: "distraction" };
	}
	if (/\b(ngu|sleep|nap|chp mat|chop mat|di ngu|thuc day|wake)\b/.test(norm)) {
		return { category: "sleep" };
	}
	if (/\b(an sang|an trua|an toi|an com|di an|lunch|dinner|breakfast|meal|bua)\b/.test(norm)) {
		return { category: "meal" };
	}
	if (/\b(len lop|giang duong|tiet hoc|lecture|class|seminar|di hoc)\b/.test(norm)) {
		return { category: "class", ...(matchedSubject ? { subject: matchedSubject } : {}) };
	}
	if (/\b(luot|tiktok|facebook|youtube|game|choi game|sao nhang|mat tap trung|distraction|scroll|reel|shorts)\b/.test(norm)) {
		return { category: "distraction" };
	}
	if (/\b(chay bo|the thao|gym|dan|nhac|music|movie|phim|hobby|giai tri|cafe|di choi)\b/.test(norm)) {
		return { category: "hobby" };
	}
	if (/\b(nghi|rest|relax|tam|tam rua|ve sinh|di chuyen|commute)\b/.test(norm)) {
		return { category: "rest" };
	}
	if (matchedSubject || /\b(hoc|on|giai|luyen|doc|chung minh|bai tap|flashcard|fsrs|study|practice|proof|olympic|code|lap trinh)\b/.test(norm)) {
		return { category: "study", ...(matchedSubject ? { subject: matchedSubject } : {}) };
	}
	return { category: "other" };
}

function parseFlexibleTimeToken(hourStr: string, minStr?: string): number | null {
	const h = Number(hourStr);
	const m = minStr ? Number(minStr) : 0;
	if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
	return h * 60 + m;
}

/**
 * Parse a freeform 24h journal ("08:30-11:00 giải 3 bài dãy số Giải tích, 14h-15h lướt tiktok...")
 * deterministically at 0 tokens into structured `JournalActivityEntry[]`.
 */
export function parseJournalTextLocal(
	journalText: string,
	date: string,
	knownSubjects: readonly string[] = [],
): JournalActivityEntry[] {
	const rawLines = journalText
		.split(/\r?\n|;+/)
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, 60);
	const out: JournalActivityEntry[] = [];
	let rollingCursorMin = 8 * 60;

	rawLines.forEach((line, idx) => {
		const rangeMatch = line.match(/(\d{1,2})\s*(?::|h)\s*(\d{2})?\s*(?:-|–|—|to|den|đến)\s*(\d{1,2})\s*(?::|h)\s*(\d{2})?/i);
		let startMin: number | null = null;
		let endMin: number | null = null;
		let durationMin = 45;
		let cleanTitle = line;

		if (rangeMatch) {
			startMin = parseFlexibleTimeToken(rangeMatch[1]!, rangeMatch[2]);
			endMin = parseFlexibleTimeToken(rangeMatch[3]!, rangeMatch[4]);
			if (startMin !== null && endMin !== null) {
				if (endMin <= startMin) endMin += 1440;
				durationMin = clamp(endMin - startMin, 5, 720);
				rollingCursorMin = endMin;
				cleanTitle = line.replace(rangeMatch[0], "").replace(/^[\s:,\-–—]+|[\s:,\-–—]+$/g, "").trim();
			}
		} else {
			const durHourMatch = line.match(/(\d+(?:[.,]\d+)?)\s*(?:h|gio|giờ|hours?)\b/i);
			const durMinMatch = line.match(/(\d+)\s*(?:m|p|phut|phút|mins?)\b/i);
			if (durHourMatch || durMinMatch) {
				const hrs = durHourMatch ? Number(durHourMatch[1]!.replace(",", ".")) : 0;
				const mins = durMinMatch ? Number(durMinMatch[1]!) : 0;
				durationMin = clamp(Math.round(hrs * 60 + mins), 5, 720);
			}
			startMin = rollingCursorMin;
			endMin = startMin + durationMin;
			rollingCursorMin = endMin;
		}

		if (startMin === null || endMin === null) return;
		const { category, subject } = classifyJournalLine(cleanTitle || line, knownSubjects);
		out.push({
			id: `jl_${date}_${idx}`,
			startTime: formatClockMin(startMin),
			endTime: formatClockMin(endMin),
			category,
			...(subject ? { subject } : {}),
			title: (cleanTitle || line).slice(0, 140),
			minutes: durationMin,
			source: "parsed_text",
		});
	});

	return out;
}

/** Explicit clock points in natural text, including Vietnamese 8r = 08:30. */
export function journalClockPoints(text: string): Set<string> {
	const points = new Set<string>();
	for (const match of text.matchAll(/\b(\d{1,2})\s*(?:(:|h)\s*(\d{1,2})?|([rR])\b)/gi)) {
		const hour = Number(match[1]), minute = match[4] ? 30 : Number(match[3] ?? 0);
		if (hour <= 23 && minute <= 59) points.add(formatClockMin(hour * 60 + minute));
	}
	return points;
}

/**
 * Deterministic (0-token) Plan-vs-Actual compliance evaluator comparing today's
 * planned study blocks & habits against the student's 24h journal + check-in log,
 * outputting an adherence score and smoothed EWMA capacity factor.
 */
export function evaluatePlanVsActualLocal(opts: {
	date: string;
	plan?: DailyStudyPlan;
	log?: DailyHabitLog;
	config: PlannerConfig;
	journalText?: string;
	manualEntries?: readonly JournalActivityEntry[];
	knownSubjects?: readonly string[];
	now?: number;
}): {
	report: PlanComplianceReport;
	parsedEntries: JournalActivityEntry[];
	suggestedRealismFactor: number;
} {
	const { date, plan, log, config } = opts;
	const known = opts.knownSubjects && opts.knownSubjects.length > 0
		? opts.knownSubjects
		: [
			...config.milestones.map((m) => m.subject),
			...(plan?.quotas.map((q) => q.subject) ?? []),
		];

	const journalStr = (opts.journalText ?? log?.journalText ?? "").trim();
	// An untimed sentence is useful context, but it must not acquire an invented clock interval.
	const explicitTimeLines = journalStr.split(/\r?\n|;+/).filter((line) => /\d{1,2}\s*(?::|h)\s*\d{0,2}\s*(?:-|–|—|to|den|đến)\s*\d{1,2}\s*(?::|h)/i.test(line));
	const parsedFromText = explicitTimeLines.length ? parseJournalTextLocal(explicitTimeLines.join("\n"), date, known) : [];
	const manual = (opts.manualEntries ?? log?.actualEntries ?? []).filter((e) => e.source === "manual");
	const savedAi = journalStr === (log?.journalText ?? "").trim() ? (log?.actualEntries ?? []).filter((entry) => entry.source === "ai_extracted" && !manual.some((item) => item.startTime === entry.startTime && item.endTime === entry.endTime)) : [];
	const combinedEntries = [...manual, ...savedAi, ...parsedFromText.filter((entry) => ![...manual, ...savedAi].some((item) => item.startTime === entry.startTime && item.endTime === entry.endTime))];

	const plannedStudyBlocks = studyBlocksForAudit(config, date, plan);
	const plannedStudyMin =
		plannedStudyBlocks.length > 0
			? plannedStudyBlocks.reduce((a, b) => a + b.durationMin, 0)
			: Math.round((plan?.plannedStudyHours ?? 0) * 60);

	const nowMs = opts.now ?? Date.now();
	const isToday = date === localDateString(nowMs);
	const nowDateObj = new Date(nowMs);
	const nowClockMin = nowDateObj.getHours() * 60 + nowDateObj.getMinutes();
	// A future interval mentioned in a journal is not evidence that the
	// corresponding plan has already come due.
	const cutoffMin = isToday ? nowClockMin : 24 * 60;
	const remainingPlannedBlocks = isToday ? plannedStudyBlocks.filter((b) => b.endMin > cutoffMin) : [];
	const remainingPlannedMin = remainingPlannedBlocks.reduce((a, b) => a + Math.max(0, b.endMin - Math.max(b.startMin, cutoffMin)), 0);
	const plannedSoFarMin = isToday
		? plannedStudyBlocks.filter((b) => b.endMin <= cutoffMin).reduce((a, b) => a + b.durationMin, 0)
		: plannedStudyMin;
	const isPartialMiddayLog = isToday && remainingPlannedMin > 0;

	const journalStudyMin = combinedEntries
		.filter((e) => e.category === "study")
		.reduce((a, e) => a + e.minutes, 0);
	const loggedMapMin = Object.values(log?.loggedStudyMinBySubject ?? {}).reduce((a, b) => a + b, 0);
	const actualStudyMin = Math.max(journalStudyMin, loggedMapMin);

	const completedBlockCount = (log?.completedBlockIds ?? []).filter((id) =>
		plannedStudyBlocks.some((b) => b.id === id),
	).length;
	const distractionMin = combinedEntries
		.filter((e) => e.category === "distraction")
		.reduce((a, e) => a + e.minutes, 0);

	const evalTargetMin = isPartialMiddayLog ? plannedSoFarMin : plannedStudyMin;
	const scorable = plannedStudyMin > 0 && (!isToday || plannedSoFarMin > 0);
	const denom = Math.max(30, evalTargetMin);
	const volumeScore = evalTargetMin === 0 ? (actualStudyMin > 0 ? 1 : 0.75) : Math.min(1.08, actualStudyMin / denom);
	const elapsedBlockCount = isPartialMiddayLog
		? plannedStudyBlocks.filter((b) => b.endMin <= cutoffMin).length
		: plannedStudyBlocks.length;
	const blockScore = elapsedBlockCount > 0 ? Math.min(1, completedBlockCount / elapsedBlockCount) : volumeScore;
	const distractionPenalty = distractionMin > 45 ? Math.min(0.22, (distractionMin - 45) / 300) : 0;
	const habitBonus = (log?.mealsOk ? 0.04 : 0) + (log?.hobbyDone ? 0.04 : 0);
	const rawAdherence = (volumeScore * 0.58 + Math.max(blockScore, volumeScore * 0.85) * 0.42 - distractionPenalty + habitBonus) * 100;
	const adherencePct = clamp(Math.round(rawAdherence), 0, 100);

	const prevRealism = config.realismFactor ?? 1.0;
	const observedRealism = isPartialMiddayLog || !scorable ? prevRealism : clamp(actualStudyMin / Math.max(30, plannedStudyMin), 0.4, 1.35);
	const suggestedRealismFactor = isPartialMiddayLog || !scorable
		? prevRealism
		: clamp(Math.round((prevRealism * 0.75 + observedRealism * 0.25) * 100) / 100, 0.65, 1.25);

	const strengths: string[] = [];
	const frictionPoints: string[] = [];

	if (isPartialMiddayLog && remainingPlannedMin > 0) {
		strengths.push(
			`Mid-day check-in (logged up to ${formatClockMin(cutoffMin)}): ${(remainingPlannedMin / 60).toFixed(1)}h planned study still ahead — EWMA capacity held steady (${Math.round(prevRealism * 100)}%).`,
		);
	}
	if (actualStudyMin >= evalTargetMin * 0.85 && actualStudyMin > 0) {
		strengths.push(`Met study pace: ${(actualStudyMin / 60).toFixed(1)}h actual vs ${(evalTargetMin / 60).toFixed(1)}h expected so far.`);
	} else if (actualStudyMin > 0) {
		frictionPoints.push(`Shortfall of ${Math.max(0, evalTargetMin - actualStudyMin)}m compared to ${(evalTargetMin / 60).toFixed(1)}h expected.`);
	} else if (scorable && (!isPartialMiddayLog || plannedSoFarMin > 0)) {
		frictionPoints.push("No study minutes logged or detected in journal yet.");
	}

	if (distractionMin >= 45) {
		frictionPoints.push(`Distraction / off-task window totaled ${distractionMin}m — anchor next scheduled block immediately.`);
	}
	if (log?.hobbyDone) strengths.push("Protected recharge / hobby rest.");
	if (log?.mealsOk) strengths.push("Kept regular meal timing.");

	const nextDayAdvice = !scorable ? "No study is due for this plan yet; capacity remains unchanged. Reassess after a planned session." : isPartialMiddayLog
		? `Remaining ${(remainingPlannedMin / 60).toFixed(1)}h planned later today — focus on your next scheduled study block and re-score tonight.`
		: observedRealism < 0.75
			? `Recorded ${actualStudyMin}m of study against ${plannedStudyMin}m planned. Tomorrow's adaptive capacity is ${(suggestedRealismFactor * 100).toFixed(0)}%.`
			: observedRealism > 1.15
				? "Strong momentum! You exceeded today's target cleanly without overreaching."
				: "Balanced pacing — keep alternating peak deep blocks with deliberate breaks.";

	return {
		report: {
			date,
			evaluatedAt: new Date(nowMs).toISOString(),
			evaluatedBy: "local",
			adherencePct,
			scorable,
			plannedStudyMin,
			actualStudyMin,
			realismRatio: Math.round(observedRealism * 100) / 100,
			summary: !scorable ? "Not enough data to score this plan yet." : isPartialMiddayLog
				? `Mid-day snapshot (${adherencePct}%): ${(actualStudyMin / 60).toFixed(1)}h studied before ${formatClockMin(cutoffMin)} (${(remainingPlannedMin / 60).toFixed(1)}h planned later today).`
				: `Adherence ${adherencePct}% · ${(actualStudyMin / 60).toFixed(1)}h studied vs ${(plannedStudyMin / 60).toFixed(1)}h planned${distractionMin > 0 ? ` · ${distractionMin}m distraction` : ""}.`,
			strengths,
			frictionPoints,
			nextDayAdvice,
		},
		parsedEntries: combinedEntries,
		suggestedRealismFactor,
	};
}

/**
 * Persist a 24h journal evaluation (local or AI) back into `config.logs[date]` and
 * update `config.realismFactor` + subject logged minutes without double counting.
 */
export function applyJournalEvaluationToConfig(
	config: PlannerConfig,
	date: string,
	opts: {
		journalText?: string;
		entries: JournalActivityEntry[];
		report: PlanComplianceReport;
		suggestedRealismFactor: number;
		now?: number;
	},
): PlannerConfig {
	const existing = config.logs[date] ?? {
		date,
		completedBlockIds: [],
		completedChecklistIds: [],
		loggedStudyMinBySubject: {},
		hobbyDone: false,
		mealsOk: false,
	};
	const loggedStudyMinBySubject = { ...existing.loggedStudyMinBySubject };
	const journalMinBySubj: Record<string, number> = {};
	for (const e of opts.entries) {
		if (e.category === "study" && e.subject) {
			journalMinBySubj[e.subject] = (journalMinBySubj[e.subject] ?? 0) + e.minutes;
		}
	}
	for (const [subj, mins] of Object.entries(journalMinBySubj)) {
		loggedStudyMinBySubject[subj] = Math.max(loggedStudyMinBySubject[subj] ?? 0, mins);
	}
	const hobbyFromJournal = opts.entries.some((e) => e.category === "hobby" && e.minutes >= 15);
	const mealsFromJournal = opts.entries.filter((e) => e.category === "meal").length >= 2;

	const nextLog: DailyHabitLog = {
		...existing,
		...(opts.journalText !== undefined ? { journalText: opts.journalText.trim().slice(0, 4000) } : {}),
		actualEntries: sanitizeActualEntries(opts.entries, date),
		compliance: sanitizeComplianceReport(opts.report, date),
		loggedStudyMinBySubject,
		hobbyDone: existing.hobbyDone || hobbyFromJournal,
		mealsOk: existing.mealsOk || mealsFromJournal,
		updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
	};

	return sanitizePlannerConfig(
		{
			...config,
			realismFactor: clamp(Math.round(opts.suggestedRealismFactor * 100) / 100, 0.65, 1.25),
			logs: {
				...config.logs,
				[date]: nextLog,
			},
			updatedAt: new Date(opts.now ?? Date.now()).toISOString(),
		},
		config,
	);
}

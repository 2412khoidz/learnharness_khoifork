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
}

export interface LifestyleConfig {
	sleep: SleepRecoveryProfile;
	meals: MealSlot[];
	hobbies: string[];
	dailyHobbyMin: number; // user baseline; adjusted gently per intensity
	blockDurationMin: number; // default 50
	breakDurationMin: number; // default 10
	strictSwitchWarning: boolean;
}

export interface DailyHabitLog {
	date: string; // YYYY-MM-DD
	actualBedtime?: string;
	actualWakeTime?: string;
	energyScore?: 1 | 2 | 3 | 4 | 5;
	completedBlockIds: string[];
	completedChecklistIds: string[];
	loggedStudyMinBySubject: Record<string, number>;
	hobbyDone: boolean;
	mealsOk: boolean;
	sleepOnTarget?: boolean;
	note?: string;
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

export interface WeeklyForecastDay {
	date: string;
	weekday: Weekday;
	freeHours: number;
	plannedHours: number;
	loadLevel: "light" | "moderate" | "heavy";
	milestoneTitles: string[];
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
}

export interface PlannerConfig {
	version: 1;
	engineMode: PlannerEngineMode;
	intensity: PlannerIntensity;
	fixedEvents: FixedWeeklyEvent[];
	milestones: StudyMilestone[];
	lifestyle: LifestyleConfig;
	logs: Record<string, DailyHabitLog>;
	plans: Record<string, DailyStudyPlan>;
	dayOverrides?: Record<string, DayOverride>;
	dismissedExamProfileIds?: string[];
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
	recentChatTitles: string[];
	lastStudiedAt: string | null;
}

export interface PlannerSessionSummary {
	id: string;
	title: string;
	kind?: "teach" | "practice";
	updatedAt: string;
}

export interface PlannerPersonalSignals {
	date: string;
	examPrep: ExamPrepStatus;
	subjectSignals: PlannerSubjectSignal[];
	mistakeHints?: ExamPrepMistakeHints;
	recentSessions: PlannerSessionSummary[];
	autoTrackedStudyMinBySubject?: Record<string, number>;
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

export const DEFAULT_LIFESTYLE_CONFIG: LifestyleConfig = {
	sleep: {
		currentBedtime: "00:30",
		targetBedtime: "23:15",
		targetSleepHours: 7.5,
		shiftStepMinPerDay: 30,
		peakFocusWindow: "auto",
	},
	meals: [
		{ id: "meal_breakfast", label: "Breakfast", startTime: "07:45", durationMin: 30 },
		{ id: "meal_lunch", label: "Lunch + Rest", startTime: "12:00", durationMin: 60 },
		{ id: "meal_dinner", label: "Dinner", startTime: "18:30", durationMin: 45 },
	],
	hobbies: ["Walking / Sport", "Music / Reading"],
	dailyHobbyMin: 60,
	blockDurationMin: 50,
	breakDurationMin: 10,
	strictSwitchWarning: true,
};

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
	version: 1,
	engineMode: "local",
	intensity: "balanced",
	fixedEvents: [],
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
	};

	const meals: MealSlot[] = Array.isArray(obj.meals)
		? obj.meals
			.filter((m): m is Record<string, unknown> => Boolean(m && typeof m === "object" && !Array.isArray(m)))
			.slice(0, 6)
			.map((m, idx) => ({
				id: typeof m.id === "string" && m.id.trim() ? m.id.trim().slice(0, 40) : `meal_${idx}`,
				label: typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, 40) : `Meal ${idx + 1}`,
				startTime: normalizeClockString(m.startTime, "12:00"),
				durationMin: clamp(Math.round(Number(m.durationMin) || 40), 15, 120),
			}))
		: fallback.meals.map((m) => ({ ...m }));

	const hobbies = Array.isArray(obj.hobbies)
		? sanitizeStringArray(obj.hobbies, 12, 60)
		: [...fallback.hobbies];

	return {
		sleep,
		meals,
		hobbies,
		dailyHobbyMin: clamp(Math.round(Number(obj.dailyHobbyMin ?? fallback.dailyHobbyMin)), 0, 240),
		blockDurationMin: clamp(Math.round(Number(obj.blockDurationMin ?? fallback.blockDurationMin)), 25, 120),
		breakDurationMin: clamp(Math.round(Number(obj.breakDurationMin ?? fallback.breakDurationMin)), 5, 30),
		strictSwitchWarning: typeof obj.strictSwitchWarning === "boolean" ? obj.strictSwitchWarning : fallback.strictSwitchWarning,
	};
}

function sanitizeLogs(raw: unknown): Record<string, DailyHabitLog> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const entries = Object.entries(raw as Record<string, unknown>)
		.filter(([date]) => DATE_RE.test(date))
		.sort(([a], [b]) => b.localeCompare(a))
		.slice(0, 60);
	const out: Record<string, DailyHabitLog> = {};
	for (const [date, val] of entries) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const v = val as Record<string, unknown>;
		const energy = v.energyScore === 1 || v.energyScore === 2 || v.energyScore === 3 || v.energyScore === 4 || v.energyScore === 5
			? v.energyScore
			: undefined;
		const loggedStudyMinBySubject: Record<string, number> = {};
		if (v.loggedStudyMinBySubject && typeof v.loggedStudyMinBySubject === "object" && !Array.isArray(v.loggedStudyMinBySubject)) {
			for (const [sub, min] of Object.entries(v.loggedStudyMinBySubject as Record<string, unknown>)) {
				if (typeof sub === "string" && sub.trim()) {
					loggedStudyMinBySubject[sub.trim().slice(0, 80)] = clamp(Math.round(Number(min) || 0), 0, 1440);
				}
			}
		}
		out[date] = {
			date,
			...(parseClockMin(v.actualBedtime) !== null ? { actualBedtime: normalizeClockString(v.actualBedtime, "23:30") } : {}),
			...(parseClockMin(v.actualWakeTime) !== null ? { actualWakeTime: normalizeClockString(v.actualWakeTime, "07:00") } : {}),
			...(energy ? { energyScore: energy } : {}),
			completedBlockIds: sanitizeStringArray(v.completedBlockIds, 60, 80),
			completedChecklistIds: sanitizeStringArray(v.completedChecklistIds, 120, 80),
			loggedStudyMinBySubject,
			hobbyDone: Boolean(v.hobbyDone),
			mealsOk: typeof v.mealsOk === "boolean" ? v.mealsOk : false,
			...(typeof v.sleepOnTarget === "boolean" ? { sleepOnTarget: v.sleepOnTarget } : {}),
			...(typeof v.note === "string" && v.note.trim() ? { note: v.note.trim().slice(0, 400) } : {}),
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
		.slice(0, 14);
	const out: Record<string, DailyStudyPlan> = {};
	for (const [date, val] of entries) {
		if (!val || typeof val !== "object" || Array.isArray(val)) continue;
		const p = val as Record<string, unknown>;
		if (!Array.isArray(p.blocks) || !Array.isArray(p.quotas)) continue;
		out[date] = p as unknown as DailyStudyPlan;
	}
	return out;
}

function sanitizeDayOverrides(raw: unknown): Record<string, DayOverride> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, DayOverride> = {};
	const entries = Object.entries(raw as Record<string, unknown>)
		.filter(([date]) => DATE_RE.test(date))
		.sort(([a], [b]) => b.localeCompare(a))
		.slice(0, 120);
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
		if (!skipFixedEvents && extraBusyEvents.length === 0 && !note && studyTargetHoursOverride === undefined) continue;
		out[date] = {
			date,
			...(skipFixedEvents ? { skipFixedEvents } : {}),
			...(extraBusyEvents.length > 0 ? { extraBusyEvents } : {}),
			...(note ? { note } : {}),
			...(studyTargetHoursOverride !== undefined ? { studyTargetHoursOverride } : {}),
		};
	}
	return out;
}

export function sanitizePlannerConfig(raw: unknown, fallback: PlannerConfig = DEFAULT_PLANNER_CONFIG): PlannerConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			...fallback,
			fixedEvents: [...fallback.fixedEvents],
			milestones: [...fallback.milestones],
			lifestyle: sanitizeLifestyle(fallback.lifestyle),
			logs: {},
			plans: {},
			dayOverrides: {},
			dismissedExamProfileIds: [],
		};
	}
	const obj = raw as Record<string, unknown>;
	const engineMode: PlannerEngineMode = obj.engineMode === "llm" ? "llm" : "local";
	const intensity: PlannerIntensity =
		obj.intensity === "healthy" || obj.intensity === "intensive" || obj.intensity === "balanced"
			? obj.intensity
			: fallback.intensity;
	return {
		version: 1,
		engineMode,
		intensity,
		fixedEvents: sanitizeFixedEvents(obj.fixedEvents, fallback.fixedEvents),
		milestones: sanitizeMilestones(obj.milestones, fallback.milestones),
		lifestyle: sanitizeLifestyle(obj.lifestyle, fallback.lifestyle),
		logs: sanitizeLogs(obj.logs),
		plans: sanitizePlans(obj.plans),
		dayOverrides: sanitizeDayOverrides(obj.dayOverrides),
		dismissedExamProfileIds: sanitizeStringArray(obj.dismissedExamProfileIds, 60, 64),
		updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : fallback.updatedAt,
	};
}

// ─── Sleep Anchor Recovery ───────────────────────────────────────────────────

/** Map bedtime onto a continuous evening-to-morning axis (>= 15:00 -> 900..2339). */
export function normalizeBedtimeMin(hhmm: string): number {
	const raw = parseClockMin(hhmm) ?? 23 * 60 + 30;
	return raw < 15 * 60 ? raw + 1440 : raw;
}

export interface SleepScheduleCalc {
	todayWakeMin: number;
	tonightBedMin: number;
	tonightWakeMin: number;
	daysToTarget: number;
	advice: string;
}

/**
 * Compute tonight's healthy sleep target + gradual circadian anchor shift.
 * If the student has been sleeping at e.g. 03:30 AM and targets 23:30,
 * stepping back by `shiftStepMinPerDay` (default 30 min) avoids unrealistic
 * sudden 4-hour shifts while steadily pulling the schedule healthy.
 */
export function computeSleepAnchorForDate(
	sleep: SleepRecoveryProfile,
	logs: Record<string, DailyHabitLog>,
	date: string,
	intensity: PlannerIntensity,
): SleepScheduleCalc {
	const pastLogs = Object.values(logs)
		.filter((l) => l.date < date && (l.actualBedtime || l.actualWakeTime))
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

	// Anchor current bedtime from the most recent logged bedtime (or profile setting)
	const baselineBedNorm = normalizeBedtimeMin(latest?.actualBedtime ?? sleep.currentBedtime);
	const targetBedNorm = normalizeBedtimeMin(sleep.targetBedtime);

	// Today's actual/estimated wake time
	let todayWakeMin: number;
	const explicitTodayWake = parseClockMin(todayLog?.actualWakeTime);
	const latestWake = parseClockMin(latest?.actualWakeTime);
	if (explicitTodayWake !== null) {
		todayWakeMin = clamp(explicitTodayWake, 4 * 60, 15 * 60);
	} else if (latestWake !== null) {
		todayWakeMin = clamp(latestWake, 4 * 60, 15 * 60);
	} else {
		const rawWake = (baselineBedNorm + sleepDurMin) % 1440;
		todayWakeMin = clamp(rawWake < 4 * 60 ? 7 * 60 : rawWake, 4 * 60, 15 * 60);
	}

	const diff = baselineBedNorm - targetBedNorm;
	let tonightBedNorm: number;
	let daysToTarget = 0;
	let advice: string;

	if (diff > 15) {
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
		advice = `On sleep target: wind down by ${formatClockMin(tonightBedNorm - 25)}, sleep at ${formatClockMin(tonightBedNorm)}.`;
	}

	// Ensure at least a valid daytime window
	if (tonightBedNorm <= todayWakeMin + 360) {
		tonightBedNorm = Math.max(todayWakeMin + 720, 23 * 60);
	}

	const tonightWakeMin = (tonightBedNorm + sleepDurMin) % 1440;
	return {
		todayWakeMin,
		tonightBedMin: tonightBedNorm,
		tonightWakeMin,
		daysToTarget,
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

function collectSubjectCandidates(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
): SubjectCandidate[] {
	const candidates: SubjectCandidate[] = [];
	const coveredClusterIds = new Set<string>();
	const coveredSubjects = new Set<string>();

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
		const daysLeft = Math.max(0, daysBetweenDates(signals.date, ms.dueDate));
		const remHours = Math.max(0.5, ms.estimatedHours - ms.completedHours);
		const sig = matchSignalForMilestone(ms, signals);
		if (sig) coveredClusterIds.add(sig.clusterId);
		for (const cid of ms.clusterIds) coveredClusterIds.add(cid);
		coveredSubjects.add(ms.subject.toLowerCase());

		const deadlinePressure = daysLeft === 0 ? 120 : 75 / Math.pow(daysLeft, 0.72);
		const workloadPressure = clamp((remHours / Math.max(1, daysLeft)) * 18, 0, 60);
		const priorityBonus = ms.priority === 3 ? 28 : ms.priority === 2 ? 14 : 4;
		const kindBonus = ms.kind === "competition" ? 16 : ms.kind === "exam" ? 10 : 6;
		const graphWeaknessBonus = sig
			? sig.dueCount * 5 + sig.weakCount * 6 + sig.untrackedCount * 1.5 + (100 - sig.readinessPct) * 0.25
			: 0;
		const urgencyScore = Math.round(deadlinePressure + workloadPressure + priorityBonus + kindBonus + graphWeaknessBonus);

		const checklist: QuotaChecklistItem[] = [];
		const openTopics = ms.syllabusTopics.filter((t) => !t.done).slice(0, 2);
		for (const t of openTopics) {
			checklist.push({ id: `chk_${ms.id}_${t.id}`, text: `Topic: ${t.title} (~${t.estHours}h)` });
		}
		if (sig && sig.dueCount > 0) {
			const sample = sig.dueSampleNames.slice(0, 2).join(", ");
			checklist.push({
				id: `chk_${ms.id}_fsrs`,
				text: `Review ${sig.dueCount} due FSRS card${sig.dueCount === 1 ? "" : "s"}${sample ? ` (${sample})` : ""}`,
			});
		}
		if (sig && sig.weakCount > 0) {
			const sample = sig.weakSampleNames.slice(0, 2).join(", ");
			checklist.push({
				id: `chk_${ms.id}_weak`,
				text: `Drill weak foundation${sig.weakCount === 1 ? "" : "s"}${sample ? `: ${sample}` : ""}`,
			});
		}
		if (checklist.length === 0) {
			checklist.push({ id: `chk_${ms.id}_core`, text: `Advance ${ms.title} (+${ms.cognitiveLoad === "heavy" ? "deep problem set" : "focused practice"})` });
		}

		const parts: string[] = [];
		parts.push(daysLeft === 0 ? "Due today" : `D-${daysLeft}`);
		if (remHours > 0) parts.push(`${Math.round(remHours * 10) / 10}h left`);
		if (sig && (sig.dueCount > 0 || sig.weakCount > 0)) {
			parts.push(`${sig.dueCount} due · ${sig.weakCount} weak`);
		}

		const weaknessSummary = sig
			? `${sig.readinessPct}% ready · ${sig.dueCount} FSRS due · ${sig.weakCount} weak · ${sig.untrackedCount} untracked`
			: undefined;

		const paceMultiplier = computeSubjectPaceMultiplier(ms.subject, config, signals.date);
		candidates.push({
			subject: ms.subject,
			milestone: ms,
			signal: sig,
			urgencyScore,
			paceMultiplier,
			cognitiveLoad: ms.cognitiveLoad,
			neededMinToday: clamp(Math.round((remHours / Math.max(1, daysLeft)) * 60 * paceMultiplier), 40, 260),
			reason: parts.join(" · "),
			weaknessSummary,
			checklist,
		});
	}

	// Add uncovered knowledge-graph subjects (stale sessions / due cards / weak foundations)
	for (const sig of signals.subjectSignals) {
		if (coveredClusterIds.has(sig.clusterId)) continue;
		if (coveredSubjects.has(sig.label.toLowerCase())) continue;
		const staleDays = sig.lastStudiedAt
			? clamp(daysBetweenDates(sig.lastStudiedAt.slice(0, 10), signals.date), 0, 14)
			: 5;
		const urgencyScore = Math.round(
			20 + sig.dueCount * 5 + sig.weakCount * 6 + sig.untrackedCount * 1.2 + (100 - sig.readinessPct) * 0.3 + staleDays * 2,
		);
		const checklist: QuotaChecklistItem[] = [];
		if (sig.dueCount > 0) {
			checklist.push({
				id: `chk_sig_${sig.clusterId}_due`,
				text: `FSRS review: ${sig.dueCount} card${sig.dueCount === 1 ? "" : "s"}${sig.dueSampleNames[0] ? ` (${sig.dueSampleNames[0]})` : ""}`,
			});
		}
		if (sig.weakCount > 0 || sig.untrackedCount > 0) {
			checklist.push({
				id: `chk_sig_${sig.clusterId}_weak`,
				text: `Strengthen ${sig.label} (${sig.weakCount} weak, ${sig.untrackedCount} untracked)`,
			});
		}
		if (checklist.length === 0) {
			checklist.push({ id: `chk_sig_${sig.clusterId}_rev`, text: `Active recall check on ${sig.label}` });
		}
		const paceMultiplier = computeSubjectPaceMultiplier(sig.label, config, signals.date);
		candidates.push({
			subject: sig.label,
			signal: sig,
			urgencyScore,
			paceMultiplier,
			cognitiveLoad: sig.weakCount > 2 || sig.untrackedCount > 5 ? "heavy" : "medium",
			neededMinToday: clamp(Math.round((45 + sig.dueCount * 6 + sig.weakCount * 10) * paceMultiplier), 40, 140),
			reason: `${sig.readinessPct}% ready · ${sig.dueCount} due`,
			weaknessSummary: `${sig.readinessPct}% ready · ${sig.dueCount} FSRS due · ${sig.weakCount} weak`,
			checklist,
		});
	}

	// General fallback when workspace has no milestones and no graph clusters yet
	if (candidates.length === 0) {
		const firstSession = signals.recentSessions[0]?.title || "Core Foundations";
		candidates.push({
			subject: firstSession,
			urgencyScore: 40,
			paceMultiplier: 1.0,
			cognitiveLoad: "medium",
			neededMinToday: 90,
			reason: "Build daily momentum",
			checklist: [{ id: "chk_default_focus", text: `Complete focused study session in ${firstSession}` }],
		});
	}

	return candidates.sort((a, b) => b.urgencyScore - a.urgencyScore).slice(0, 6);
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

function scoreAssignmentOrder<T extends AssignableSubject>(
	rawSlots: readonly SchedulableSlot[],
	assignments: ReadonlyArray<T | null>,
	tonightBedMin: number,
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
 * rewarding peak-hour alignment and spaced intervals.
 */
export function optimizeSlotAssignments<T extends AssignableSubject>(
	rawSlots: readonly SchedulableSlot[],
	initialAssignments: ReadonlyArray<T | null>,
	tonightBedMin: number,
): Array<T | null> {
	const best = [...initialAssignments];
	if (best.length < 2) return best;

	let bestScore = scoreAssignmentOrder(rawSlots, best, tonightBedMin);
	for (let pass = 0; pass < 3; pass++) {
		let improved = false;
		for (let i = 0; i < best.length; i++) {
			for (let j = i + 1; j < best.length; j++) {
				if (best[i] === best[j]) continue;
				const tmp = best[i]!;
				best[i] = best[j]!;
				best[j] = tmp;
				const nextScore = scoreAssignmentOrder(rawSlots, best, tonightBedMin);
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

function computeWeeklyForecast(
	config: PlannerConfig,
	startDate: string,
	totalUrgencyNeeded: number,
): WeeklyForecastDay[] {
	const modeUtilization =
		config.intensity === "healthy" ? 0.58 : config.intensity === "intensive" ? 0.86 : 0.72;
	const baseHobby = config.lifestyle.dailyHobbyMin;
	const targetHobbyMin =
		config.intensity === "healthy"
			? Math.max(baseHobby, 75)
			: config.intensity === "intensive"
				? Math.min(baseHobby, 35)
				: baseHobby;

	const out: WeeklyForecastDay[] = [];
	for (let offset = 0; offset < 7; offset++) {
		const date = addDaysToDate(startDate, offset);
		const weekday = weekdayForDate(date);
		const dayOverride = config.dayOverrides?.[date];
		const sleepCalc = computeSleepAnchorForDate(config.lifestyle.sleep, config.logs, date, config.intensity);
		let intervals: TimeInterval[] = [{ startMin: sleepCalc.todayWakeMin, endMin: sleepCalc.tonightBedMin - 25 }];

		for (const ev of resolveBusyEventsForDate(config, date)) {
			const s = parseClockMin(ev.startTime);
			const e = parseClockMin(ev.endTime);
			if (s === null || e === null || e <= s) continue;
			const iv = { startMin: Math.max(s, sleepCalc.todayWakeMin), endMin: Math.min(e, sleepCalc.tonightBedMin - 25) };
			if (iv.endMin > iv.startMin) intervals = subtractInterval(intervals, iv);
		}
		for (const meal of config.lifestyle.meals) {
			const s = parseClockMin(meal.startTime);
			if (s === null) continue;
			const iv = { startMin: Math.max(s, sleepCalc.todayWakeMin), endMin: Math.min(s + meal.durationMin, sleepCalc.tonightBedMin - 25) };
			if (iv.endMin - iv.startMin >= 15) intervals = subtractInterval(intervals, iv);
		}

		const freeBeforeHobby = intervals.reduce((acc, iv) => acc + Math.max(0, iv.endMin - iv.startMin), 0);
		const hobbyMin = Math.min(targetHobbyMin, Math.max(0, Math.floor(freeBeforeHobby * 0.25)));
		const focusAvail = Math.max(0, freeBeforeHobby - hobbyMin);
		const plannedMin =
			dayOverride?.studyTargetHoursOverride !== undefined
				? Math.min(focusAvail, Math.round(dayOverride.studyTargetHoursOverride * 60))
				: Math.min(
					Math.round(focusAvail * 0.9),
					Math.max(
						Math.min(focusAvail * modeUtilization, totalUrgencyNeeded + 30),
						Math.min(focusAvail, config.intensity === "intensive" ? 240 : 120),
					),
				);
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
		});
	}
	return out;
}

/**
 * Compute daily study schedule locally in ~1-5ms (0 tokens).
 */
export function computeLocalPlannerPlan(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	now = Date.now(),
): DailyStudyPlan {
	const date = signals.date;
	const dayOverride = config.dayOverrides?.[date];
	const sleepCalc = computeSleepAnchorForDate(config.lifestyle.sleep, config.logs, date, config.intensity);

	const fixedBlocks: PlannedBlock[] = [];
	const dayEvents = resolveBusyEventsForDate(config, date);

	let awakeIntervals: TimeInterval[] = [{ startMin: sleepCalc.todayWakeMin, endMin: sleepCalc.tonightBedMin - 25 }];

	for (const ev of dayEvents) {
		const s = parseClockMin(ev.startTime);
		const e = parseClockMin(ev.endTime);
		if (s === null || e === null || e <= s) continue;
		const iv = { startMin: Math.max(s, sleepCalc.todayWakeMin), endMin: Math.min(e, sleepCalc.tonightBedMin - 25) };
		if (iv.endMin > iv.startMin) {
			awakeIntervals = subtractInterval(awakeIntervals, iv);
			fixedBlocks.push({
				id: ev.id,
				date,
				startTime: formatClockMin(iv.startMin),
				endTime: formatClockMin(iv.endMin),
				startMin: iv.startMin,
				endMin: iv.endMin,
				durationMin: iv.endMin - iv.startMin,
				type: "fixed",
				title: ev.title,
				reason: ev.reason,
			});
		}
	}

	for (const meal of config.lifestyle.meals) {
		const s = parseClockMin(meal.startTime);
		if (s === null) continue;
		const e = s + meal.durationMin;
		const iv = { startMin: Math.max(s, sleepCalc.todayWakeMin), endMin: Math.min(e, sleepCalc.tonightBedMin - 25) };
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

	const totalFreeBeforeHobby = awakeIntervals.reduce((acc, iv) => acc + Math.max(0, iv.endMin - iv.startMin), 0);
	const freeHoursTotal = Math.round((totalFreeBeforeHobby / 60) * 10) / 10;

	// Scale hobby/recharge time cleanly with intensity
	const baseHobby = config.lifestyle.dailyHobbyMin;
	const targetHobbyMin =
		config.intensity === "healthy"
			? Math.max(baseHobby, 75)
			: config.intensity === "intensive"
				? Math.min(baseHobby, 35)
				: baseHobby;
	const hobbyMin = Math.min(targetHobbyMin, Math.max(0, Math.floor(totalFreeBeforeHobby * 0.25)));

	// Place hobby block in late afternoon/evening (around 17:00..22:30) where longest gap >= hobbyMin
	const hobbyBlocks: PlannedBlock[] = [];
	if (hobbyMin >= 20 && awakeIntervals.length > 0) {
		const preferredEveningStart = 19 * 60 + 30;
		let chosenIdx = -1;
		let chosenStart = 0;
		for (let i = awakeIntervals.length - 1; i >= 0; i--) {
			const iv = awakeIntervals[i]!;
			if (iv.endMin - iv.startMin >= hobbyMin) {
				chosenIdx = i;
				chosenStart = clamp(preferredEveningStart, iv.startMin, iv.endMin - hobbyMin);
				if (iv.startMin >= 16 * 60 || i === awakeIntervals.length - 1) break;
			}
		}
		if (chosenIdx >= 0) {
			const hIv = { startMin: chosenStart, endMin: chosenStart + hobbyMin };
			awakeIntervals = subtractInterval(awakeIntervals, hIv);
			const hobbyList = config.lifestyle.hobbies.length > 0 ? config.lifestyle.hobbies.join(" / ") : "Recharge & Hobby";
			hobbyBlocks.push({
				id: `blk_hobby_${date}`,
				date,
				startTime: formatClockMin(hIv.startMin),
				endTime: formatClockMin(hIv.endMin),
				startMin: hIv.startMin,
				endMin: hIv.endMin,
				durationMin: hobbyMin,
				type: "hobby",
				title: `Hobby / Rest: ${hobbyList}`,
				reason: config.intensity === "healthy" ? "Protected wellness recovery" : "Scheduled mental reset",
			});
		}
	}

	const focusBudgetAvailable = awakeIntervals.reduce((acc, iv) => acc + Math.max(0, iv.endMin - iv.startMin), 0);
	const modeUtilization =
		config.intensity === "healthy" ? 0.58 : config.intensity === "intensive" ? 0.86 : 0.72;
	const candidates = collectSubjectCandidates(config, signals);
	const totalUrgencyNeeded = candidates.reduce((acc, c) => acc + c.neededMinToday, 0);
	const rawStudyBudget =
		dayOverride?.studyTargetHoursOverride !== undefined
			? Math.min(focusBudgetAvailable, Math.round(dayOverride.studyTargetHoursOverride * 60))
			: Math.min(
				Math.round(focusBudgetAvailable * 0.9),
				Math.max(
					Math.min(focusBudgetAvailable * modeUtilization, totalUrgencyNeeded + 30),
					Math.min(focusBudgetAvailable, config.intensity === "intensive" ? 240 : 120),
				),
			);

	// Minimum daily study hours needed across deadlines, clamped to safe limits
	const deadlineMinNeed = candidates.reduce((acc, c) => {
		if (!c.milestone) return acc + 30;
		const d = Math.max(1, daysBetweenDates(date, c.milestone.dueDate));
		const rem = Math.max(0, c.milestone.estimatedHours - c.milestone.completedHours);
		return acc + (rem / d) * 60;
	}, 0);
	const minDailyMin =
		dayOverride?.studyTargetHoursOverride !== undefined
			? Math.min(focusBudgetAvailable, Math.round(dayOverride.studyTargetHoursOverride * 60))
			: Math.min(
				focusBudgetAvailable,
				Math.max(60, Math.round(Math.max(deadlineMinNeed, rawStudyBudget * 0.75) / 15) * 15),
			);
	const minDailyStudyHours = Math.round((minDailyMin / 60) * 10) / 10;

	// Allocate minutes across multiple subjects cleanly (anti-monopoly cap <= 55% when >= 2 subjects)
	const quotasBySubject = new Map<string, number>();
	if (rawStudyBudget >= 20) {
		const urgencySum = Math.max(1, candidates.reduce((acc, c) => acc + c.urgencyScore, 0));
		const capFraction = candidates.length >= 2 && config.intensity !== "intensive" ? 0.55 : candidates.length >= 2 ? 0.65 : 1;
		let allocatedSum = 0;
		for (const c of candidates) {
			const rawShare = Math.round((rawStudyBudget * c.urgencyScore) / urgencySum);
			const capped = Math.min(rawShare, Math.round(rawStudyBudget * capFraction));
			const rounded = Math.max(Math.min(25, rawStudyBudget), Math.round(capped / 15) * 15);
			quotasBySubject.set(c.subject, rounded);
			allocatedSum += rounded;
		}
		if (allocatedSum > focusBudgetAvailable && candidates.length > 0) {
			const ratio = (focusBudgetAvailable * 0.85) / allocatedSum;
			for (const c of candidates) {
				quotasBySubject.set(c.subject, Math.max(20, Math.round(((quotasBySubject.get(c.subject) ?? 30) * ratio) / 5) * 5));
			}
		}
	}

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

		// Prefer not repeating same subject twice in a row unless only 1 remains
		const nonRepeating = available.filter((c) => c.subject !== lastAssignedSubject);
		const pool = nonRepeating.length > 0 ? nonRepeating : available;
		pool.sort((a, b) => {
			if (slot.isPeak) {
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

	const optimizedAssignments = optimizeSlotAssignments(rawSlots, slotAssignments, sleepCalc.tonightBedMin);
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
		startTime: formatClockMin(sleepCalc.tonightBedMin - 25),
		endTime: formatClockMin(sleepCalc.tonightBedMin),
		startMin: sleepCalc.tonightBedMin - 25,
		endMin: sleepCalc.tonightBedMin,
		durationMin: 25,
		type: "sleep",
		title: `Wind-down → Sleep by ${formatClockMin(sleepCalc.tonightBedMin)}`,
		reason: sleepCalc.advice,
	};

	const allBlocks = [...fixedBlocks, ...hobbyBlocks, ...studyAndBreakBlocks, windDownBlock].sort(
		(a, b) => a.startMin - b.startMin,
	);
	const plannedMin = [...actualAssignedBySubject.values()].reduce((a, b) => a + b, 0);

	// Add recurring mistake reminder into top subject's checklist if available
	const topMistakeRule = signals.mistakeHints?.recentRules[0];
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
		minDailyStudyHours,
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
		weeklyForecast: computeWeeklyForecast(config, date, totalUrgencyNeeded),
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
	return {
		date: signals.date,
		weekday: weekdayForDate(signals.date),
		intensity: config.intensity,
		awakeWindow: {
			wake: baselinePlan.todayWakeTime,
			recommendedBedtime: baselinePlan.recommendedBedtime,
			sleepShiftAdvice: baselinePlan.sleepShiftAdvice,
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
		hobbies: config.lifestyle.hobbies,
		milestones: config.milestones.slice(0, 12).map((m) => ({
			id: m.id,
			kind: m.kind,
			title: m.title,
			subject: m.subject,
			dueDate: m.dueDate,
			daysLeft: daysBetweenDates(signals.date, m.dueDate),
			hoursRemaining: Math.max(0, Math.round((m.estimatedHours - m.completedHours) * 10) / 10),
			load: m.cognitiveLoad,
			openTopics: m.syllabusTopics.filter((t) => !t.done).slice(0, 4).map((t) => t.title),
		})),
		knowledgeSignals: signals.subjectSignals.slice(0, 8).map((s) => ({
			label: s.label,
			readinessPct: s.readinessPct,
			dueCount: s.dueCount,
			weakCount: s.weakCount,
			untrackedCount: s.untrackedCount,
			dueSample: s.dueSampleNames.slice(0, 3),
			weakSample: s.weakSampleNames.slice(0, 3),
		})),
		mistakes: signals.mistakeHints
			? {
				total: signals.mistakeHints.totalCount,
				pattern: signals.mistakeHints.recurringPattern,
				topRules: signals.mistakeHints.recentRules.slice(0, 3),
			}
			: null,
		habitTrend: signals.habitTrend,
		localBaseline: {
			minDailyStudyHours: baselinePlan.minDailyStudyHours,
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
): DailyStudyPlan {
	const staticBlocks = baselinePlan.blocks.filter((b) => b.type === "fixed" || b.type === "meal" || b.type === "sleep");
	const busy = staticBlocks.map((b) => ({ startMin: b.startMin, endMin: b.endMin }));
	const date = baselinePlan.date;
	const wakeMin = parseClockMin(baselinePlan.todayWakeTime) ?? 420;

	const toMonotonicMin = (hhmm: string): number | null => {
		const m = parseClockMin(hhmm);
		if (m === null) return null;
		return m < wakeMin - 60 ? m + 1440 : m;
	};

	const acceptedDynamic: PlannedBlock[] = [];
	const usedIntervals: TimeInterval[] = [...busy];
	const overlapsAny = (s: number, e: number) => usedIntervals.some((iv) => s < iv.endMin && e > iv.startMin);

	if (Array.isArray(payload.blocks)) {
		payload.blocks.slice(0, 24).forEach((raw, idx) => {
			const s = toMonotonicMin(raw.startTime);
			const e = toMonotonicMin(raw.endTime);
			if (s === null || e === null || e - s < 10 || e - s > 240) return;
			if (overlapsAny(s, e)) return;
			const kind = raw.type === "hobby" || raw.type === "break" ? raw.type : "study";
			const title = String(raw.title || "").trim().slice(0, 100);
			if (!title) return;
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

	const studyBlocks = acceptedDynamic.filter((b) => b.type === "study");
	const finalBlocks = studyBlocks.length >= 1
		? [...staticBlocks, ...acceptedDynamic].sort((a, b) => a.startMin - b.startMin)
		: baselinePlan.blocks;

	const plannedStudyMin = finalBlocks
		.filter((b) => b.type === "study")
		.reduce((acc, b) => acc + b.durationMin, 0);

	let finalQuotas = baselinePlan.quotas;
	if (Array.isArray(payload.quotas) && payload.quotas.length > 0) {
		const validQ = payload.quotas
			.filter((q) => typeof q.subject === "string" && q.subject.trim())
			.slice(0, 6)
			.map((q, idx) => {
				const base = baselinePlan.quotas.find((b) => b.subject.toLowerCase() === q.subject.trim().toLowerCase());
				const checklist = Array.isArray(q.checklist) && q.checklist.length > 0
					? q.checklist.slice(0, 4).map((t, j) => ({ id: `chk_ai_${idx}_${j}`, text: String(t).trim().slice(0, 120) }))
					: base?.checklist ?? [{ id: `chk_ai_${idx}_0`, text: `Study ${q.subject.trim()}` }];
				return {
					id: base?.id ?? `q_ai_${idx}`,
					subject: q.subject.trim().slice(0, 80),
					...(base?.milestoneId ? { milestoneId: base.milestoneId } : {}),
					targetMin: clamp(Math.round(Number(q.targetMin) || 45), 20, 480),
					urgencyScore: base?.urgencyScore ?? 60,
					...(base?.weaknessSummary ? { weaknessSummary: base.weaknessSummary } : {}),
					checklist,
				};
			});
		if (validQ.length > 0) finalQuotas = validQ;
	}

	return {
		...baselinePlan,
		engineUsed: "llm",
		minDailyStudyHours:
			typeof payload.minDailyStudyHours === "number" && Number.isFinite(payload.minDailyStudyHours)
				? clamp(Math.round(payload.minDailyStudyHours * 10) / 10, 0.5, 14)
				: baselinePlan.minDailyStudyHours,
		plannedStudyHours: Math.round((plannedStudyMin / 60) * 10) / 10,
		quotas: finalQuotas,
		blocks: finalBlocks,
		coachSummary: String(payload.coachSummary || "").trim().slice(0, 800),
		modelUsed,
	};
}

// ─── Habit Check-in & Active Block Helpers ───────────────────────────────────

export interface HabitCheckInPatch {
	date?: string;
	toggleBlockId?: string;
	toggleChecklistId?: string;
	addStudyMin?: { subject: string; minutes: number; milestoneId?: string };
	actualBedtime?: string;
	actualWakeTime?: string;
	energyScore?: 1 | 2 | 3 | 4 | 5;
	hobbyDone?: boolean;
	mealsOk?: boolean;
	sleepOnTarget?: boolean;
	note?: string;
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

	const nextLog: DailyHabitLog = {
		...existing,
		...(patch.actualBedtime !== undefined && parseClockMin(patch.actualBedtime) !== null
			? { actualBedtime: normalizeClockString(patch.actualBedtime, existing.actualBedtime ?? "23:30") }
			: {}),
		...(patch.actualWakeTime !== undefined && parseClockMin(patch.actualWakeTime) !== null
			? { actualWakeTime: normalizeClockString(patch.actualWakeTime, existing.actualWakeTime ?? "07:00") }
			: {}),
		...(patch.energyScore !== undefined ? { energyScore: patch.energyScore } : {}),
		...(patch.hobbyDone !== undefined ? { hobbyDone: patch.hobbyDone } : { hobbyDone }),
		...(patch.mealsOk !== undefined ? { mealsOk: patch.mealsOk } : {}),
		...(patch.sleepOnTarget !== undefined ? { sleepOnTarget: patch.sleepOnTarget } : {}),
		...(patch.note !== undefined ? { note: patch.note.trim().slice(0, 400) } : {}),
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

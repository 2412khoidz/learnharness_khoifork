/**
 * Pure TypeScript FSRS-6 scheduler (adapted verbatim from plugins/flashcards/src/scheduler.cjs,
 * selectively adapted from ts-fsrs 5.2.3, MIT, Open Spaced Repetition).
 *
 * Bundled directly inside src/core so Next.js standalone desktop builds never depend on
 * external filesystem `.cjs` files inside plugins/ or core-plugins/.
 */

export interface FsrsSchedule {
	due: number;
	dueDay?: string;
	stability: number;
	difficulty: number;
	elapsed_days: number;
	scheduled_days: number;
	reps: number;
	lapses: number;
	learning_steps: number;
	state: number;
	last_review: number | null;
}

export interface FsrsSettings {
	retention?: number;
	learningSteps?: number[];
	relearningSteps?: number[];
	dayStart?: number;
	weights?: number[];
	fuzz?: boolean;
}

export interface FsrsCueLike {
	latestRating?: number | null;
}

export const W = Object.freeze([
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
	0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
	1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]) as readonly number[];

export const WEIGHT_BOUNDS = Object.freeze([
	[0.01, 50], [0.01, 50], [0.01, 50], [0.01, 50],
	[1, 10], [0.01, 5], [0.01, 8], [0, 0.75],
	[0, 4], [0, 0.8], [0.01, 3.5], [0.01, 5],
	[0.01, 0.5], [0.01, 1], [0, 5], [0, 1],
	[1, 6], [0, 2], [0, 2], [0, 0.8], [0.1, 0.8],
] as const);

export const MIN_OPTIMIZER_REVIEWS = 30;

const MINUTE = 60_000;
const DAY = 86_400_000;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const round8 = (v: number) => +v.toFixed(8);
const DECAY = -W[20]!;
const FACTOR = round8(Math.exp(Math.pow(DECAY, -1) * Math.log(0.9)) - 1);

export function isValidWeights(weights: unknown): weights is number[] {
	return Array.isArray(weights) && weights.length === 21 && weights.every((n, i) => {
		const [min, max] = WEIGHT_BOUNDS[i]!;
		return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
	});
}

function resolveWeights(settings?: FsrsSettings): readonly number[] {
	return isValidWeights(settings?.weights) ? settings!.weights : W;
}

function decayFactor(w: readonly number[]): { decay: number; factor: number } {
	if (w === W) return { decay: DECAY, factor: FACTOR };
	const decay = -w[20]!;
	const factor = round8(Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1);
	return { decay, factor };
}

function timestamp(now: number): number {
	if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
		throw new RangeError("Expected a finite epoch-millisecond timestamp");
	}
	return now;
}

export function dayBounds(now: number, startHour = 4): { start: number; end: number } {
	timestamp(now);
	if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
		throw new RangeError("dayStart must be an integer from 0 to 23");
	}
	const start = new Date(now);
	start.setHours(startHour, 0, 0, 0);
	if (+start > now) {
		start.setDate(start.getDate() - 1);
		start.setHours(startHour, 0, 0, 0);
	}
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	end.setHours(startHour, 0, 0, 0);
	return { start: +start, end: +end };
}

export function studyDay(now: number, startHour = 4): string {
	const date = new Date(dayBounds(now, startHour).start);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function ordinal(now: number, startHour: number): number {
	const date = new Date(dayBounds(now, startHour).start);
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

function reviewDue(now: number, days: number, dayStart: number): number {
	const date = new Date(dayBounds(now, dayStart).start);
	date.setDate(date.getDate() + days);
	// Restore the requested rollover even if the starting date crossed a DST gap.
	date.setHours(dayStart, 0, 0, 0);
	return +date;
}

interface NormalizedSettings {
	learningSteps: number[];
	relearningSteps: number[];
	dayStart: number;
	w: readonly number[];
	decay: number;
	factor: number;
	fuzz: boolean;
	modifier: number;
}

function settingsFor(settings: FsrsSettings = {}): NormalizedSettings {
	const retention = settings.retention ?? 0.9;
	if (!Number.isFinite(retention) || retention <= 0 || retention > 1) {
		throw new RangeError("retention must be in (0, 1]");
	}
	const learningSteps = settings.learningSteps ?? [1, 10];
	const relearningSteps = settings.relearningSteps ?? [10];
	for (const steps of [learningSteps, relearningSteps]) {
		if (!Array.isArray(steps) || steps.some((step) => !Number.isFinite(step) || step <= 0)) {
			throw new RangeError("Learning steps must be arrays of positive minutes");
		}
	}
	const dayStart = settings.dayStart ?? 4;
	dayBounds(0, dayStart);
	const w = resolveWeights(settings);
	const { decay, factor } = decayFactor(w);
	return {
		learningSteps,
		relearningSteps,
		dayStart,
		w,
		decay,
		factor,
		fuzz: Boolean(settings.fuzz),
		modifier: round8((Math.pow(retention, 1 / decay) - 1) / factor),
	};
}

export function createSchedule(now = Date.now()): FsrsSchedule {
	return {
		due: timestamp(now),
		stability: 0,
		difficulty: 0,
		elapsed_days: 0,
		scheduled_days: 0,
		reps: 0,
		lapses: 0,
		learning_steps: 0,
		state: 0,
		last_review: null,
	};
}

function initDifficulty(rating: number, w: readonly number[] = W): number {
	return round8(w[4]! - Math.exp((rating - 1) * w[5]!) + 1);
}

function nextDifficulty(difficulty: number, rating: number, w: readonly number[] = W): number {
	const delta = round8((-w[6]! * (rating - 3) * (10 - difficulty)) / 9);
	return clamp(round8(w[7]! * initDifficulty(4, w) + (1 - w[7]!) * (difficulty + delta)), 1, 10);
}

function shortStability(stability: number, rating: number, w: readonly number[] = W): number {
	const increase = Math.pow(stability, -w[19]!) * Math.exp(w[17]! * (rating - 3 + w[18]!));
	return round8(clamp(stability * (rating >= 3 ? Math.max(increase, 1) : increase), 0.001, 36500));
}

function reviewStability(
	schedule: { difficulty: number; stability: number },
	rating: number,
	elapsed: number,
	w: readonly number[] = W,
): number {
	const { difficulty: d, stability: s } = schedule;
	const { decay, factor } = decayFactor(w);
	const r = round8(Math.pow(1 + (factor * elapsed) / s, decay));
	if (rating === 1) {
		const forgotten = round8(
			clamp(
				w[11]! * Math.pow(d, -w[12]!) * (Math.pow(s + 1, w[13]!) - 1) * Math.exp((1 - r) * w[14]!),
				0.001,
				36500,
			),
		);
		return clamp(round8(s / Math.exp(w[17]! * w[18]!)), 0.001, forgotten);
	}
	const hard = rating === 2 ? w[15]! : 1;
	const easy = rating === 4 ? w[16]! : 1;
	return round8(
		clamp(
			s *
				(1 +
					Math.exp(w[8]!) *
						(11 - d) *
						Math.pow(s, -w[9]!) *
						(Math.exp((1 - r) * w[10]!) - 1) *
						hard *
						easy),
			0.001,
			36500,
		),
	);
}

function interval(stability: number, settings: NormalizedSettings): number {
	return clamp(Math.round(stability * settings.modifier), 1, 36500);
}

function hashSeed(input: string): number {
	let h = 2166136261;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967295;
}

function applyFuzz(
	days: number,
	schedule: { last_review?: number | null; reps?: number; lapses?: number },
	now: number,
	options: NormalizedSettings,
	rating = 0,
): number {
	if (!options.fuzz || days < 3) return days;
	const delta = Math.max(1, Math.round(days * 0.05));
	const u = hashSeed(`${schedule?.last_review ?? ""}:${now}:${schedule?.reps ?? 0}:${schedule?.lapses ?? 0}:${rating}`);
	return clamp(Math.round(days + (u * 2 - 1) * delta), 1, 36500);
}

/** Live continuous retrievability R(t) in [0, 1] at timestamp `now`. */
export function retrievability(
	schedule: Partial<FsrsSchedule> | Record<string, unknown> | null | undefined,
	now = Date.now(),
	settings: FsrsSettings = {},
): number {
	timestamp(now);
	const state = typeof schedule?.state === "number" ? schedule.state : 0;
	const lastReview = typeof schedule?.last_review === "number" ? schedule.last_review : null;
	const stability = typeof schedule?.stability === "number" ? schedule.stability : 0;
	if (!schedule || state === 0 || lastReview == null || !stability || stability <= 0) {
		return 0;
	}
	const w = resolveWeights(settings);
	const { decay, factor } = decayFactor(w);
	const elapsedDays = Math.max(0, (now - lastReview) / DAY);
	return clamp(round8(Math.pow(1 + (factor * elapsedDays) / stability, decay)), 0, 1);
}

function learningInfo(schedule: FsrsSchedule, rating: number, settings: NormalizedSettings): { minutes: number; step: number } {
	const steps = schedule.state === 2 || schedule.state === 3 ? settings.relearningSteps : settings.learningSteps;
	let step = schedule.learning_steps || 0;
	if (schedule.state === 1 && rating >= 3) step += 1;
	if (steps.length === 0 || step >= steps.length) return { minutes: 0, step: 0 };
	if (schedule.state === 2) return { minutes: steps[step]!, step: 0 };
	if (rating === 1) return { minutes: steps[0]!, step: 0 };
	if (rating === 2) {
		return { minutes: Math.round(steps.length === 1 ? steps[0]! * 1.5 : (steps[0]! + steps[1]!) / 2), step };
	}
	if (rating === 3 && steps[step + 1]) return { minutes: Math.round(steps[step + 1]!), step: step + 1 };
	return { minutes: 0, step: 0 };
}

function applySteps(
	next: FsrsSchedule,
	previous: FsrsSchedule,
	rating: number,
	now: number,
	settings: NormalizedSettings,
): void {
	const { minutes, step } = learningInfo(previous, rating, settings);
	if (minutes > 0) {
		next.learning_steps = step;
		next.scheduled_days = Math.floor(minutes / 1440);
		next.state = minutes < 1440 ? (previous.state === 2 ? 3 : previous.state || 1) : 2;
		next.due = now + Math.round(minutes) * MINUTE;
	} else {
		next.learning_steps = 0;
		next.state = 2;
		next.scheduled_days = applyFuzz(interval(next.stability, settings), previous, now, settings, rating);
		next.due = reviewDue(now, next.scheduled_days, settings.dayStart);
	}
}

export function rate(
	rawSchedule: FsrsSchedule | Record<string, unknown>,
	rating: number,
	now = Date.now(),
	settings: FsrsSettings = {},
): FsrsSchedule {
	timestamp(now);
	if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
		throw new RangeError("rating must be 1–4");
	}
	const schedule = rawSchedule as unknown as FsrsSchedule;
	if (!schedule || !Number.isInteger(schedule.state) || schedule.state < 0 || schedule.state > 3) {
		throw new RangeError("Invalid schedule state");
	}
	const options = settingsFor(settings);
	const w = options.w;
	const steps = schedule.state === 2 || schedule.state === 3 ? options.relearningSteps : options.learningSteps;
	const current: FsrsSchedule = steps.length && schedule.learning_steps >= steps.length
		? { ...schedule, learning_steps: steps.length - 1 }
		: { ...schedule };
	const elapsed = current.state === 0 || current.last_review == null
		? 0
		: Math.max(0, ordinal(now, options.dayStart) - ordinal(current.last_review, options.dayStart));
	const next: FsrsSchedule = {
		...current,
		elapsed_days: elapsed,
		reps: (current.reps ?? 0) + 1,
		last_review: now,
	};
	if (current.state === 0) {
		next.stability = Math.max(w[rating - 1]!, 0.1);
		next.difficulty = clamp(initDifficulty(rating, w), 1, 10);
	} else {
		next.difficulty = nextDifficulty(current.difficulty, rating, w);
		next.stability = current.state === 2
			? reviewStability(current, rating, elapsed, w)
			: shortStability(current.stability, rating, w);
	}
	if (current.state !== 2 || rating === 1) {
		if (current.state === 2) next.lapses = (next.lapses ?? 0) + 1;
		applySteps(next, current, rating, now, options);
	} else {
		const rawHard = interval(reviewStability(current, 2, elapsed, w), options);
		const rawGood = interval(reviewStability(current, 3, elapsed, w), options);
		const rawEasy = interval(reviewStability(current, 4, elapsed, w), options);
		const hard = applyFuzz(Math.min(rawHard, rawGood), current, now, options, 2);
		const good = Math.max(applyFuzz(rawGood, current, now, options, 3), hard + 1);
		const easy = Math.max(applyFuzz(rawEasy, current, now, options, 4), good + 1);
		next.scheduled_days = ({ 2: hard, 3: good, 4: easy } as Record<number, number>)[rating]!;
		next.state = 2;
		next.learning_steps = 0;
		next.due = reviewDue(now, next.scheduled_days, options.dayStart);
	}
	if (next.state === 2) next.dueDay = studyDay(next.due, options.dayStart);
	else delete next.dueDay;
	return next;
}

export function preview(
	schedule: FsrsSchedule | Record<string, unknown>,
	now = Date.now(),
	settings: FsrsSettings = {},
): Record<number, FsrsSchedule> {
	return {
		1: rate(schedule, 1, now, settings),
		2: rate(schedule, 2, now, settings),
		3: rate(schedule, 3, now, settings),
		4: rate(schedule, 4, now, settings),
	};
}

export function chooseCue<T extends FsrsCueLike>(
	cues: readonly T[],
	random: () => number = Math.random,
): T | null {
	if (!cues.length) return null;
	const weight = (cue: T) => ({ 1: 4, 2: 3, 3: 2, 4: 1 }[cue.latestRating ?? 0] ?? 3);
	const total = cues.reduce((sum, cue) => sum + weight(cue), 0);
	let target = random() * total;
	for (const cue of cues) {
		target -= weight(cue);
		if (target < 0) return cue;
	}
	return cues[cues.length - 1]!;
}

export function isDue(
	schedule: { state?: number; due?: number; dueDay?: string },
	now = Date.now(),
	startHour = 4,
): boolean {
	const today = studyDay(now, startHour);
	if (schedule.state === 2 && schedule.dueDay) return today >= schedule.dueDay;
	return (schedule.due ?? Infinity) <= now;
}

export const BUNDLED_FSRS_SCHEDULER = {
	W,
	WEIGHT_BOUNDS,
	MIN_OPTIMIZER_REVIEWS,
	isValidWeights,
	createSchedule,
	rate,
	preview,
	retrievability,
	chooseCue,
	studyDay,
	dayBounds,
	isDue,
};

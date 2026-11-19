import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	computeGraphFsrsSummary,
	emptyGraphFsrsSummary,
	type FlashcardsStoreSnapshot,
	type GraphFsrsSummary,
} from "../core/fsrs-graph.ts";
import { BUNDLED_FSRS_SCHEDULER } from "../core/fsrs-scheduler.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import { graphView } from "./graph.ts";
import { projectRecallFsrs } from "../core/recall-fsrs.ts";
import { readRecallFsrsEvents } from "./recall-fsrs-store.ts";

export interface FlashcardsSchedulerModule {
	rate(
		schedule: Record<string, unknown>,
		rating: 1 | 2 | 3 | 4,
		now: number,
		settings?: Record<string, unknown>,
	): Record<string, unknown>;
	preview(
		schedule: Record<string, unknown>,
		now?: number,
		settings?: Record<string, unknown>,
	): Record<number, Record<string, unknown> & { state?: number; due?: number; scheduled_days?: number }>;
	retrievability(
		schedule: Record<string, unknown>,
		now?: number,
		settings?: Record<string, unknown>,
	): number;
	chooseCue<T extends { latestRating?: number | null }>(cues: T[]): T | null;
	isDue(schedule: Record<string, unknown>, now?: number, startHour?: number): boolean;
	studyDay(now: number, startHour?: number): string;
}

/** Return the pure-TS bundled FSRS-6 scheduler (never hits external plugins/ paths at runtime). */
export function loadFlashcardsScheduler(): FlashcardsSchedulerModule {
	return BUNDLED_FSRS_SCHEDULER as unknown as FlashcardsSchedulerModule;
}

export function defaultFlashcardsStorePath(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "core-plugin-data", "flashcards", "flashcards.json");
}

/** Read and parse the raw Flashcards JSON store without overlaying Recall-FSRS projections. */
export function readRawFlashcardsFile(
	flashcardsFile = defaultFlashcardsStorePath(),
): FlashcardsStoreSnapshot | null {
	let raw: string;
	try {
		raw = fs.readFileSync(/* turbopackIgnore: true */ flashcardsFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			raw = JSON.stringify({ propositions: {} });
		} else {
			return null;
		}
	}
	try {
		const parsed = JSON.parse(raw) as FlashcardsStoreSnapshot;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Read and parse the Flashcards FSRS-6 JSON snapshot safely (`null` when unreadable/corrupt). */
export function readFlashcardsSnapshot(
	flashcardsFile = defaultFlashcardsStorePath(),
): FlashcardsStoreSnapshot | null {
	const parsed = readRawFlashcardsFile(flashcardsFile);
	if (!parsed) return null;
	// Recall histories are projected in memory only. They never add cards to
	// the Flashcards store or overwrite a separately reviewed card schedule.
	if (flashcardsFile === defaultFlashcardsStorePath()) {
		try {
			const projection = projectRecallFsrs(readRecallFsrsEvents(), parsed.settings);
			parsed.propositions ??= {};
			const used = new Set<string>();
			for (const [id, schedule] of Object.entries(projection.schedules)) {
				const current = parsed.propositions[id];
				if ((current?.schedule?.reps ?? 0) > 0) continue;
				parsed.propositions[id] = { ...current, id, schedule, recallOnly: true };
				used.add(id);
			}
			parsed.reviews = [...(Array.isArray(parsed.reviews) ? parsed.reviews : []), ...projection.reviews.filter((review) => used.has(review.propositionId))];
		} catch { /* keep genuine Flashcards data if the separate ledger is unreadable */ }
	}
	return parsed;
}

/** Read Flashcards FSRS-6 state and project it onto the current Knowledge Graph. */
export function readGraphFsrsSummary(
	snapshot: Pick<GraphSnapshot, "nodes" | "chains"> = graphView(),
	flashcardsFile = defaultFlashcardsStorePath(),
	now = Date.now(),
): GraphFsrsSummary {
	const parsed = readFlashcardsSnapshot(flashcardsFile);
	if (!parsed) return emptyGraphFsrsSummary();
	return computeGraphFsrsSummary(snapshot, parsed, now);
}

export interface PracticeFsrsUpdateInput {
	targets: string[];
	outcome: "solved" | "solvedWithHints" | "movedOn" | "surrendered" | "dismissed";
	rung: string | null;
	missClass: string | null;
	retest: boolean;
	flashcardsFile?: string;
	now?: number;
}

export interface PracticeFsrsUpdateResult {
	updatedPropositionIds: string[];
	ratings: Record<string, 1 | 2 | 3 | 4>;
	oneDayRecheckIds: string[];
}

interface FlashcardsPropositionEntry {
	id?: string;
	cues?: Array<{ deleted?: boolean }>;
	schedule?: {
		state: number;
		due: number;
		dueDay?: string;
		stability: number;
		difficulty: number;
		elapsed_days?: number;
		scheduled_days?: number;
		reps?: number;
		lapses?: number;
		learning_steps?: number;
		last_review?: number | null;
	};
	firstReviewedAt?: number | null;
	version?: number;
}

interface FlashcardsStoreFile {
	revision?: number;
	settings?: Record<string, unknown> & { dayStart?: number };
	propositions?: Record<string, FlashcardsPropositionEntry>;
	reviews?: unknown[];
}

/**
 * Update Flashcards FSRS-6 scheduling for a Practice problem's target propositions
 * when concluded (`conclude` tool). Distinguishes careless slips from forgetting
 * and applies a 1-day re-check for single-miss strong propositions rather than
 * resetting long-established stability.
 */
export function recordPracticeFsrsOutcome(input: PracticeFsrsUpdateInput): PracticeFsrsUpdateResult {
	const empty: PracticeFsrsUpdateResult = {
		updatedPropositionIds: [],
		ratings: {},
		oneDayRecheckIds: [],
	};
	if (!input.targets?.length || input.outcome === "dismissed" || input.outcome === "movedOn") {
		return empty;
	}
	const file = input.flashcardsFile ?? defaultFlashcardsStorePath();
	let store: FlashcardsStoreFile;
	try {
		if (!fs.existsSync(file)) return empty;
		store = JSON.parse(fs.readFileSync(file, "utf8")) as FlashcardsStoreFile;
	} catch {
		return empty;
	}
	if (!store || typeof store !== "object" || !store.propositions || typeof store.propositions !== "object") {
		return empty;
	}

	const scheduler = loadFlashcardsScheduler();
	const nowMs = input.now ?? Date.now();
	const updatedPropositionIds: string[] = [];
	const ratings: Record<string, 1 | 2 | 3 | 4> = {};
	const oneDayRecheckIds: string[] = [];

	for (const propId of [...new Set(input.targets)]) {
		const prop = store.propositions[propId];
		if (!prop || !prop.schedule || !Array.isArray(prop.cues) || !prop.cues.some((c) => !c.deleted)) {
			continue;
		}
		const sched = prop.schedule;
		let rating: 1 | 2 | 3 | 4;
		let oneDayRecheck = false;

		if (input.outcome === "solved") {
			if (input.missClass === "careless") {
				rating = 3;
			} else if (input.rung === null && input.missClass === null && (sched.reps ?? 0) >= 2) {
				rating = 4;
			} else {
				rating = 3;
			}
		} else if (input.outcome === "solvedWithHints") {
			if (input.missClass === "careless" || input.rung === "R0" || input.rung === "R1") {
				rating = 2;
			} else if ((sched.stability ?? 0) >= 7 && (sched.lapses ?? 0) === 0) {
				rating = 2;
				oneDayRecheck = true;
			} else {
				rating = 1;
			}
		} else {
			if ((sched.stability ?? 0) >= 10 && (sched.lapses ?? 0) === 0 && !input.retest) {
				rating = 2;
				oneDayRecheck = true;
			} else {
				rating = 1;
			}
		}

		const before = { ...sched };
		const next = scheduler.rate(before, rating, nowMs, store.settings ?? {}) as NonNullable<
			FlashcardsPropositionEntry["schedule"]
		>;
		if (oneDayRecheck) {
			const recheckDue = nowMs + 86_400_000;
			next.due = recheckDue;
			next.scheduled_days = 1;
			if (next.state === 2) {
				next.dueDay = scheduler.studyDay(recheckDue, typeof store.settings?.dayStart === "number" ? store.settings.dayStart : 4);
			}
			oneDayRecheckIds.push(propId);
		}

		prop.schedule = next;
		prop.firstReviewedAt ??= nowMs;
		prop.version = (prop.version ?? 0) + 1;

		store.reviews ??= [];
		store.reviews.push({
			id: randomUUID(),
			requestId: `practice:${randomUUID()}`,
			source: "practice",
			propositionId: propId,
			rating,
			at: nowMs,
			before,
			after: next,
			introduced: before.state === 0,
		});

		updatedPropositionIds.push(propId);
		ratings[propId] = rating;
	}

	if (updatedPropositionIds.length > 0) {
		store.revision = (store.revision ?? 0) + 1;
		fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
	}

	return { updatedPropositionIds, ratings, oneDayRecheckIds };
}

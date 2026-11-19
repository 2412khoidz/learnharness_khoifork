import { createSchedule, rate, type FsrsSchedule, type FsrsSettings } from "./fsrs-scheduler.ts";

/** Confirmed evidence is kept separately from Flashcards; no cue is created. */
export interface RecallFsrsEvent {
	answerId: string;
	nodeId: string;
	rating: 1 | 2 | 3 | 4;
	answeredAt: number;
	confirmedAt: number;
	batchId: string;
	revertedAt?: number;
}

export interface RecallFsrsProjection {
	schedules: Record<string, FsrsSchedule>;
	reviews: Array<{ requestId: string; propositionId: string; rating: 1 | 2 | 3 | 4; at: number; source: "recall" }>;
}

/** Replay confirmed responses at their original times, not at import time. */
export function projectRecallFsrs(events: readonly RecallFsrsEvent[], settings?: FsrsSettings): RecallFsrsProjection {
	const schedules: Record<string, FsrsSchedule> = {};
	const reviews: RecallFsrsProjection["reviews"] = [];
	const seen = new Set<string>();
	for (const event of [...events].sort((a, b) => a.answeredAt - b.answeredAt || a.answerId.localeCompare(b.answerId))) {
		if (event.revertedAt || seen.has(event.answerId) || !event.nodeId || !Number.isFinite(event.answeredAt) || event.answeredAt <= 0 || ![1, 2, 3, 4].includes(event.rating)) continue;
		seen.add(event.answerId);
		const previous = schedules[event.nodeId] ?? createSchedule(event.answeredAt);
		schedules[event.nodeId] = rate(previous, event.rating, event.answeredAt, { ...settings, learningSteps: [], relearningSteps: [], fuzz: false });
		reviews.push({ requestId: `recall:${event.answerId}`, propositionId: event.nodeId, rating: event.rating, at: event.answeredAt, source: "recall" });
	}
	return { schedules, reviews };
}

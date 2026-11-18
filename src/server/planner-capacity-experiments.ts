import { optimizeParameters } from "../../plugins/flashcards/src/scheduler.cjs";
import { createSchedule, rate, retrievability, W, type FsrsSchedule } from "../core/fsrs-scheduler.ts";
import type { CapacityExperiments } from "../core/learning-capacity.ts";
import { evaluateRecallPrediction, probabilityLoss } from "../core/recall-prediction.ts";
import { readFlashcardsSnapshot } from "./graph-fsrs.ts";
import { readPlannerLearningCapacityServer } from "./planner.ts";

type Review = { propositionId: string; rating: 1 | 2 | 3 | 4; at: number };
const HALF_DAY = 43_200_000;

export function evaluateFsrsForecast(input: readonly unknown[], now: number) {
	const rows = input.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const row = entry as Partial<Review> & { source?: string };
		if (row.source === "recall" || row.source === "practice" || typeof row.propositionId !== "string" ||
			typeof row.at !== "number" || !Number.isFinite(row.at) || row.at <= 0 || row.at > now ||
			!row.rating || ![1, 2, 3, 4].includes(row.rating)) return [];
		return [{ propositionId: row.propositionId, at: row.at, rating: row.rating }];
	}).sort((a, b) => a.at - b.at);
	const insufficient = { status: "insufficient" as const, observations: rows.length };
	if (rows.length < 50) return insufficient;
	const last = new Map<string, number>();
	const transitions = rows.filter((row) => {
		const at = last.get(row.propositionId);
		last.set(row.propositionId, row.at);
		return at !== undefined && row.at - at >= HALF_DAY;
	});
	if (transitions.length < 30) return insufficient;
	const cutoff = transitions[transitions.length - Math.max(20, Math.ceil(transitions.length * 0.2))]!.at;
	const train = rows.filter((row) => row.at < cutoff);
	const trainLong = transitions.filter((row) => row.at < cutoff).length;
	const testLong = transitions.length - trainLong;
	if (train.length < 30 || trainLong < 10 || testLong < 20) return insufficient;
	const fitted = optimizeParameters(train);
	if (!fitted.ok) return insufficient;
	const replay = (weights: readonly number[]) => {
		const histories = new Map<string, FsrsSchedule>();
		const predictions: { y: number; p: number }[] = [];
		for (const row of rows) {
			const before = histories.get(row.propositionId);
			if (before?.last_review != null && row.at >= cutoff && row.at - before.last_review >= HALF_DAY) {
				predictions.push({ y: row.rating > 1 ? 1 : 0, p: retrievability(before, row.at, { weights: [...weights] }) });
			}
			histories.set(row.propositionId, rate(before ?? createSchedule(row.at), row.rating, row.at, { weights: [...weights], fuzz: false }));
		}
		return probabilityLoss(predictions);
	};
	const reference = replay(W);
	const measured = replay(fitted.weights);
	return {
		status: measured.brier < reference.brier && measured.logLoss < reference.logLoss ? "improved" as const : "baseline" as const,
		train: train.length, test: testLong, measured, reference,
	};
}

export function runCapacityExperiments(date?: string): CapacityExperiments {
	const now = Date.now();
	const { recallSources } = readPlannerLearningCapacityServer({ date, now });
	const flashcards = readFlashcardsSnapshot();
	return {
		fsrs: evaluateFsrsForecast(Array.isArray(flashcards?.reviews) ? flashcards.reviews : [], now),
		recall: evaluateRecallPrediction(recallSources.map((item) => item.observation), now),
	};
}

import assert from "node:assert/strict";
import { it } from "node:test";
import { computeLearningCapacityReport } from "../src/core/learning-capacity.ts";
import { DEFAULT_PLANNER_CONFIG, type PlannerPersonalSignals } from "../src/core/planner.ts";
import { computeRecallCapacity, recallCompositeAdjustment } from "../src/core/recall-capacity.ts";
import type { RecallObservation } from "../src/core/recall-insights.ts";
import { evaluateRecallPrediction, recallPredictionRows } from "../src/core/recall-prediction.ts";

const now = new Date(2026, 10, 18, 18).getTime();
const at = (age: number, minute = 0) => new Date(2026, 10, 18 - age, 10, minute).getTime();
const answer = (id: string, age: number, options: Partial<RecallObservation> = {}, minute = 0): RecallObservation => ({
	id, chatId: "synthetic", toolCallId: id, subject: "Math", answeredAt: new Date(at(age, minute)).toISOString(),
	askedAt: at(age, minute) - 1000, confirmedAt: at(age, minute) + 1000,
	verdict: "correct", source: "user", help: "independent", ...options,
});
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

it("keeps two observed rates, discards repeat prompts for weighting and caps a burst per subject-day", () => {
	const first = answer("a", 0, { promptKey: "repeat" });
	const rows = [
		first, first, answer("b", 0, { promptKey: "repeat", verdict: "wrong" }, 3),
		answer("c", 0), answer("d", 0), answer("e", 0), answer("f", 14, { verdict: "partial", promptKey: "repeat" }),
		answer("g", 0, { verdict: "uncertain" }), answer("h", 0, { help: "assisted", verdict: "partial" }),
		answer("i", 30), answer("j", -1),
	];
	const profile = computeRecallCapacity(rows, now);
	assert.equal(profile.responses, 8);
	assert.equal(profile.graded, 7);
	assert.equal(profile.uncertain, 1);
	assert.equal(profile.assisted, 1);
	assert.equal(profile.usable, 5);
	assert.deepEqual(profile.raw, { full: 4 / 7, atLeastPartial: 6 / 7 });
	close(profile.weighted, 3.5);
	assert.deepEqual(profile.estimate, { full: 0.7, atLeastPartial: 0.9 });
	assert.equal(profile.leaveOneDayOut, null);
});

it("weights by provenance, assistance and recency and reports sensitivity to each day", () => {
	const rows = [
		answer("confirmed", 0, { verdict: "wrong" }),
		answer("provisional", 1, { source: "ai", help: "unknown" }),
		answer("old", 14, { verdict: "partial", toolCallId: undefined }),
	];
	const profile = computeRecallCapacity(rows, now);
	const provisionalMass = 0.25 * 2 ** (-1 / 14);
	close(profile.weighted, 1.5 + provisionalMass);
	close(profile.estimate!.full, (0.5 + provisionalMass) / (3 + provisionalMass));
	close(profile.confirmedEstimate!.full, 0.5 / 3);
	assert.equal(profile.overlapUnknown, 1);
	assert.equal(profile.provisional, 1);
	assert.ok(profile.leaveOneDayOut!.full[0] < profile.estimate!.full);
	assert.ok(profile.leaveOneDayOut!.full[1] > profile.estimate!.full);
});

it("uses subject shrinkage, includes low-evidence subjects in the denominator and preserves the five-point bound", () => {
	const enough = computeRecallCapacity(Array.from({ length: 12 }, (_, i) => answer(String(i), Math.floor(i / 3))), now);
	const scarce = computeRecallCapacity([answer("scarce", 0)], now);
	const result = recallCompositeAdjustment(35, [enough, scarce]);
	close(result.delta, 0.05 / 2 * enough.weighted / (enough.weighted + 8) * (100 * enough.estimate!.full - 35));
	assert.equal(result.eligibleSubjects, 1);
	assert.equal(recallCompositeAdjustment(null, [enough]).score, null);
	assert.equal(recallCompositeAdjustment(35, [scarce]).score, 35);
	for (let base = 0; base <= 100; base++) {
		for (const full of [0, 1]) {
			const extreme = { ...enough, weighted: 1e9, estimate: { full, atLeastPartial: full } };
			assert.ok(Math.abs(recallCompositeAdjustment(base, [extreme]).score! - base) <= 5);
		}
	}
});

it("excludes the same source answer across Quiz, Mistakes and Recall-FSRS from the composite contribution once", () => {
	const signals: PlannerPersonalSignals = {
		date: "2026-11-18", examPrep: { subjects: [] } as unknown as PlannerPersonalSignals["examPrep"], subjectSignals: [],
		recentSessions: [], habitTrend: { loggedDays: 0, avgEnergy: null, latestBedtime: null, avgStudyMin: 0 },
	};
	const report = computeLearningCapacityReport({
		config: DEFAULT_PLANNER_CONFIG, signals, now,
		recallObservationsBySubject: { math: [answer("quiz", 0), answer("mistake", 1), answer("fsrs", 1), answer("independent", 0)] },
		quizSamples: [{ subject: "Math", sessionTitle: "Math", origin: "quiz", confidencePct: 80, correct: true, dontKnow: false, answerId: "quiz" }],
		mistakes: [{ id: "mistake", status: "failed" }] as unknown as NonNullable<Parameters<typeof computeLearningCapacityReport>[0]["mistakes"]>,
		fsrsRecallAnswerIds: ["fsrs", "quiz"],
	});
	assert.equal(report.subjectBreakdown[0]?.recallCapacity?.overlapExcluded, 3);
	assert.equal(report.subjectBreakdown[0]?.recallCapacity?.raw?.full, 1);
	assert.equal(report.subjectBreakdown[0]?.recallCapacity?.usable, 1);
	assert.equal(report.compositeScore, report.legacyCompositeScore);
});

it("constructs Recall forecasts with only the labels known before that question", () => {
	const late = answer("late", 10, { confirmedAt: at(1), verdict: "wrong" });
	const prior = answer("prior", 5, { verdict: "partial" });
	const old = answer("old", 15);
	const target = answer("target", 2);
	const upcoming = answer("upcoming", 1);
	const forecast = recallPredictionRows([late, prior, old, target, upcoming], now);
	assert.deepEqual(forecast.find((row) => row.id === "target")?.x, [1, 0, Math.log(2), 0, Math.log(2), Math.log(2), 0]);
	assert.equal(evaluateRecallPrediction([late, prior, old, target, upcoming], now).status, "insufficient");
});

it("evaluates across disjoint days and removes training labels corrected after the cutoff", () => {
	const rows = Array.from({ length: 150 }, (_, i) => answer(
		String(i), 14 - Math.floor(i / 10),
		{ verdict: i % 2 ? "correct" : "partial", ...(i === 0 ? { confirmedAt: at(0) } : {}) }, i % 10,
	));
	const result = evaluateRecallPrediction(rows, now);
	assert.notEqual(result.status, "insufficient");
	assert.ok("train" in result);
	assert.equal(result.train, 119);
	assert.equal(result.test, 30);
	assert.equal(Object.hasOwn(result, "next"), result.status === "improved");
});

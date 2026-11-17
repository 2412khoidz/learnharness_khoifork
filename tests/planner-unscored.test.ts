import assert from "node:assert/strict";
import { it } from "node:test";
import { applyHabitCheckIn, archivePlannerPlan, DEFAULT_PLANNER_CONFIG, evaluatePlanVsActualLocal, sanitizePlannerConfig, studyBlocksForAudit, type DailyStudyPlan } from "../src/core/planner.ts";

it("does not score or reduce capacity when there is no study plan", () => {
	const config = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, realismFactor: 0.85 });
	const result = evaluatePlanVsActualLocal({ date: "2026-11-16", config, journalText: "", now: new Date(2026, 10, 16, 20).getTime() });
	assert.equal(result.report.scorable, false);
	assert.equal(result.suggestedRealismFactor, 0.85);
	assert.equal(result.report.realismRatio, 0.85);
	assert.match(result.report.summary, /Not enough data/);
});

it("does not score or change capacity when every study block is still in the future", () => {
	const config = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, realismFactor: 0.9 });
	const plan = { blocks: [{ type: "study", startMin: 960, endMin: 980, durationMin: 20 }], plannedStudyHours: 1 / 3, quotas: [] } as unknown as DailyStudyPlan;
	const result = evaluatePlanVsActualLocal({ date: "2026-11-16", config, plan, journalText: "", now: new Date(2026, 10, 16, 15).getTime() });
	assert.equal(result.report.scorable, false);
	assert.equal(result.suggestedRealismFactor, 0.9);
});

it("preserves capacity during an ongoing late-evening block", () => {
	const config = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, realismFactor: 0.9 });
	const plan = { blocks: [{ type: "study", startMin: 1260, endMin: 1305, durationMin: 45 }], plannedStudyHours: 0.75, quotas: [] } as unknown as DailyStudyPlan;
	const result = evaluatePlanVsActualLocal({ date: "2026-11-16", config, plan, journalText: "", now: new Date(2026, 10, 16, 21, 10).getTime() });
	assert.equal(result.report.scorable, false);
	assert.equal(result.suggestedRealismFactor, 0.9);
});

it("does not let a future journal interval make a future study block due", () => {
	const config = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, realismFactor: 0.9 });
	const plan = { blocks: [{ type: "study", startMin: 960, endMin: 1005, durationMin: 45 }], plannedStudyHours: 0.75, quotas: [] } as unknown as DailyStudyPlan;
	const result = evaluatePlanVsActualLocal({ date: "2026-11-16", config, plan, journalText: "08:00-20:00 Rest", now: new Date(2026, 10, 16, 15).getTime() });
	assert.equal(result.report.scorable, false);
	assert.equal(result.suggestedRealismFactor, 0.9);
});

it("retains a daily note and manually recorded habit in the shared journal log", () => {
	const note = "a".repeat(600);
	const config = applyHabitCheckIn(DEFAULT_PLANNER_CONFIG, { date: "2026-11-16", note, habitCounts: [{ id: "count-1", name: "Activity", count: 3 }], actualEntries: [{ id: "manual-1", startTime: "18:00", endTime: "18:30", category: "hobby", title: "Reading", minutes: 30, source: "manual" }] });
	const saved = sanitizePlannerConfig(config).logs["2026-11-16"];
	assert.equal(saved?.note, note);
	assert.equal(saved?.actualEntries?.[0]?.id, "manual-1");
	assert.deepEqual(saved?.habitCounts, [{ id: "count-1", name: "Activity", count: 3 }]);
});

it("does not discard habit history after a year", () => {
	const logs: Record<string, unknown> = {};
	for (let i = 0; i < 400; i++) {
		const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
		logs[date] = { date, note: "Recorded" };
	}
	assert.equal(Object.keys(sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, logs }).logs).length, 400);
});

it("retains only elapsed blocks from an earlier plan when a day is replanned", () => {
	const date = "2026-11-16";
	const previous = { date, generatedAt: new Date(2026, 10, 16, 9).toISOString(), quotas: [], blocks: [
		{ id: "before-creation", type: "study", startMin: 480, endMin: 510, durationMin: 30 },
		{ id: "missed", type: "study", startMin: 600, endMin: 660, durationMin: 60 },
		{ id: "never-due", type: "study", startMin: 1020, endMin: 1065, durationMin: 45 },
	] } as unknown as DailyStudyPlan;
	const current = { date, generatedAt: new Date(2026, 10, 16, 16).toISOString(), quotas: [], plannedStudyHours: 0.75, blocks: [{ id: "new", type: "study", startMin: 1020, endMin: 1065, durationMin: 45 }] } as unknown as DailyStudyPlan;
	const base = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, plans: { [date]: previous } });
	const archived = archivePlannerPlan(base, date, new Date(2026, 10, 16, 16).getTime());
	const restored = sanitizePlannerConfig({ ...archived, plans: { [date]: current } });
	assert.deepEqual(studyBlocksForAudit(restored, date, current).map((block) => block.id), ["missed", "new"]);
	const result = evaluatePlanVsActualLocal({ date, config: restored, plan: current, now: new Date(2026, 10, 16, 16, 15).getTime() });
	assert.equal(result.report.plannedStudyMin, 105);
	assert.equal(result.report.scorable, true);
});

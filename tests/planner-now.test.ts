import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLlmPlanOutput, computeLocalPlannerPlan, computeExamPrepStatus,
  DEFAULT_EXAM_PREP_CONFIG, DEFAULT_PLANNER_CONFIG, emptyGraphFsrsSummary,
  sanitizePlannerConfig, type PlannerPersonalSignals,
} from "../src/core/index.ts";

function sampleSignals(date = "2026-11-16"): PlannerPersonalSignals {
	const availableScopes = [
		{ id: "c_calc", label: "Olympic Giải tích", nodeCount: 8, trackedCount: 6, dueCount: 3, readinessPct: 52 },
		{ id: "c_os", label: "Hệ điều hành", nodeCount: 4, trackedCount: 3, dueCount: 1, readinessPct: 68 },
	];
	const mistakeHints = {
		totalCount: 3,
		recurringPattern: "setup-error (2)",
		recentRules: ["Kiểm tra điều kiện liên tục trên đoạn đóng [a,b] trước khi áp dụng Rolle."],
	};
	return {
		date,
		examPrep: computeExamPrepStatus(DEFAULT_EXAM_PREP_CONFIG, emptyGraphFsrsSummary(), Date.UTC(2026, 10, 16), [], {
			availableScopes,
			activeScopeLabels: ["Olympic Giải tích"],
			scopedNodeCount: 12,
			totalNodeCount: 12,
			mistakeHints,
		}),
		subjectSignals: [
			{
				clusterId: "c_calc",
				label: "Olympic Giải tích",
				nodeCount: 8,
				trackedCount: 6,
				dueCount: 3,
				weakCount: 2,
				untrackedCount: 2,
				readinessPct: 52,
				dueSampleNames: ["Định lý Rolle", "Chuỗi Taylor"],
				weakSampleNames: ["Giới hạn dãy số"],
				recentChatTitles: ["Dạy giải tích olympic sinh viên"],
				lastStudiedAt: "2026-11-13T10:00:00Z",
			},
			{
				clusterId: "c_os",
				label: "Hệ điều hành",
				nodeCount: 4,
				trackedCount: 3,
				dueCount: 1,
				weakCount: 1,
				untrackedCount: 1,
				readinessPct: 68,
				dueSampleNames: ["Deadlock avoidance"],
				weakSampleNames: ["Virtual memory paging"],
				recentChatTitles: ["OS Paging"],
				lastStudiedAt: "2026-11-15T10:00:00Z",
			},
		],
		mistakeHints: {
			totalCount: 3,
			recurringPattern: "setup-error (2)",
			recentRules: ["Kiểm tra điều kiện liên tục trên đoạn đóng [a,b] trước khi áp dụng Rolle."],
		},
		recentSessions: [
			{ id: "c1", title: "Dạy giải tích olympic sinh viên", updatedAt: "2026-11-15T10:00:00Z" },
		],
		habitTrend: { loggedDays: 2, avgEnergy: 3.5, latestBedtime: "03:00", avgStudyMin: 180 },
	};
}


describe("Remaining-day planning", () => {
  const date = "2026-11-16";
  const now = new Date(2026, 10, 16, 15, 51).getTime();
  const signals = sampleSignals(date);
  const config = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, dayOverrides: {
    [date]: { date, customBlocks: [
      { id: "past", date, startTime: "09:00", endTime: "10:00", startMin: 540, endMin: 600, durationMin: 60, type: "study", title: "Past", subject: "Math" },
      { id: "ongoing", date, startTime: "15:30", endTime: "16:15", startMin: 930, endMin: 975, durationMin: 45, type: "study", title: "Current", subject: "Math" },
      { id: "later", date, startTime: "17:00", endTime: "17:30", startMin: 1020, endMin: 1050, durationMin: 30, type: "study", title: "Later", subject: "Math" },
    ] },
  } });

  it("clips a current block, removes past ones, and leaves the saved override intact", () => {
    const result = computeLocalPlannerPlan(config, signals, now, { fromNow: true });
    assert.deepEqual(result.blocks.map((b) => [b.id, b.startTime, b.endTime, b.durationMin]), [
      ["ongoing", "15:51", "16:15", 24], ["later", "17:00", "17:30", 30],
    ]);
    assert.equal(result.quotas[0]?.targetMin, 54);
    assert.equal(config.dayOverrides?.[date]?.customBlocks?.[0]?.id, "past");
    const saved = computeLocalPlannerPlan(config, signals, now);
    assert.equal(saved.blocks[0]?.id, "past");
    const otherDate = computeLocalPlannerPlan(config, sampleSignals("2026-11-17"), now, { fromNow: true });
    assert.ok(otherDate.blocks.some((b) => b.startMin < 15 * 60 + 51));
  });

  it("does not replace an expired custom schedule with an automatic one", () => {
    const late = new Date(2026, 10, 16, 23, 59).getTime();
    const result = computeLocalPlannerPlan(config, signals, late, { fromNow: true });
    assert.equal(result.isCustomEdited, true);
    assert.deepEqual(result.blocks, []);
    assert.deepEqual(result.quotas, []);
    assert.equal(result.plannedStudyHours, 0);
  });

  it("persists an explicitly empty custom schedule and handles no time left", () => {
    const empty = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, dayOverrides: { [date]: { date, customBlocks: [] } } });
    const result = computeLocalPlannerPlan(empty, signals, now, { fromNow: true });
    assert.equal(result.isCustomEdited, true);
    assert.deepEqual(result.blocks, []);
    assert.equal(result.plannedStudyHours, 0);

    const late = new Date(2026, 10, 16, 23, 59).getTime();
    const auto = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, lifestyle: {
      ...DEFAULT_PLANNER_CONFIG.lifestyle,
      sleep: { ...DEFAULT_PLANNER_CONFIG.lifestyle.sleep, currentBedtime: "23:00", targetBedtime: "23:00" },
    } });
    const baseline = computeLocalPlannerPlan(auto, signals, late, { fromNow: true });
    const merged = applyLlmPlanOutput(baseline, {
      coachSummary: "Study early this morning", blocks: [{ startTime: "09:00", endTime: "10:00", type: "study", title: "Past" }],
      quotas: [{ subject: "Math", targetMin: 200, checklist: [] }],
    }, auto, "fake", { now: late });
    assert.equal(merged.blocks.filter((b) => b.type === "study").length, 0);
    assert.equal(merged.plannedStudyHours, 0);
    assert.equal(merged.quotas.length, 0);
    assert.equal(merged.minDailyStudyHours, 0);
  });

  it("honors an AI rest-only or empty plan without inventing study", () => {
    const auto = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG });
    const baseline = computeLocalPlannerPlan(auto, signals, now, { fromNow: true });
    for (const blocks of [[], [{ startTime: "16:15", endTime: "16:45", type: "break" as const, title: "Rest" }]]) {
      const result = applyLlmPlanOutput(baseline, { coachSummary: "Take a break", blocks }, auto, "fake", { now });
      assert.equal(result.blocks.filter((b) => b.type === "study").length, 0);
      assert.equal(result.quotas.length, 0);
      assert.equal(result.plannedStudyHours, 0);
      if (blocks.length) assert.ok(result.blocks.some((b) => b.title === "Rest"));
    }
  });

  it("clips custom sessions to bedtime and reflects them in the forecast", () => {
    const auto = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, lifestyle: {
      ...DEFAULT_PLANNER_CONFIG.lifestyle,
      sleep: { ...DEFAULT_PLANNER_CONFIG.lifestyle.sleep, currentBedtime: "23:00", targetBedtime: "23:00" },
    }, dayOverrides: { [date]: { date, customBlocks: [
      { id: "crosses", date, startTime: "22:45", endTime: "23:30", startMin: 1365, endMin: 1410, durationMin: 45, type: "study", title: "Review", subject: "Math" },
      { id: "after", date, startTime: "23:30", endTime: "00:30", startMin: 1410, endMin: 1470, durationMin: 60, type: "study", title: "Too late", subject: "Math" },
    ] } } });
    const result = computeLocalPlannerPlan(auto, signals, now, { fromNow: true });
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0]?.endTime, "23:00");
    assert.equal(result.quotas[0]?.targetMin, 15);
    assert.equal(result.weeklyForecast?.[0]?.subjects?.[0]?.plannedMinutes, 15);
  });

  it("allows a valid session across midnight within the planned sleep boundary", () => {
    const late = new Date(2026, 10, 16, 23, 20).getTime();
    const auto = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, lifestyle: {
      ...DEFAULT_PLANNER_CONFIG.lifestyle,
      sleep: { ...DEFAULT_PLANNER_CONFIG.lifestyle.sleep, currentBedtime: "01:30", targetBedtime: "01:30" },
    } });
    const baseline = computeLocalPlannerPlan(auto, signals, late, { fromNow: true });
    const merged = applyLlmPlanOutput(baseline, {
      coachSummary: "Late review", blocks: [{ startTime: "23:30", endTime: "00:15", type: "study", title: "Late review", subject: "Math" }],
    }, auto, "fake", { now: late });
    const block = merged.blocks.find((b) => b.title === "Late review");
    assert.equal(block?.startMin, 1410);
    assert.equal(block?.endMin, 1455);
  });

  it("bounds AI proposals by the current minute and sleep, synchronizing quotas with accepted sessions", () => {
    const auto = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG });
    const baseline = computeLocalPlannerPlan(auto, signals, now, { fromNow: true });
    const result = applyLlmPlanOutput(baseline, {
      coachSummary: "Past task at 09:00 is scheduled",
      blocks: [
        { startTime: "09:00", endTime: "10:00", type: "study", title: "Past", subject: "Math" },
        { startTime: "15:30", endTime: "16:15", type: "study", title: "Current", subject: "Math" },
        { startTime: "17:00", endTime: "17:30", type: "study", title: "Later", subject: "Math" },
        { startTime: "02:00", endTime: "03:00", type: "study", title: "After bedtime", subject: "Math" },
      ],
      quotas: [{ subject: "Math", targetMin: 300, checklist: ["Review"] }],
    }, auto, "fake", { now });
    const studies = result.blocks.filter((b) => b.type === "study");
    assert.ok(studies.length > 0);
    assert.ok(result.blocks.every((b) => b.startMin >= 951));
    assert.ok(!result.blocks.some((b) => b.title === "Past" || b.title === "After bedtime"));
    assert.equal(studies.find((b) => b.title === "Current")?.startTime, "15:51");
    assert.equal(result.quotas.reduce((sum, q) => sum + q.targetMin, 0), studies.reduce((sum, b) => sum + b.durationMin, 0));
    assert.ok(!result.coachSummary?.includes("Past task"));
  });
});

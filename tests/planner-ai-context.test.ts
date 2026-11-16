import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { checkInPlannerHabit, chatWithPlannerCoachServer, evaluateDailyJournalServer, generatePlannerSchedule, readPlannerSnapshot } from "../src/server/planner.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-replan-ai-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const now = new Date(2026, 10, 16, 15, 51).getTime();
const date = "2026-11-16";
const journal = "08:00-08:15 thủ dâm\n08:15-09:00 đọc sách\n12:30-13:00 nghỉ trưa";

function fakeEngine(toolName: string, args: unknown, capture: (prompt: string) => void): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall(toolName, args as ToolCall["arguments"], { id: "tc_1" })], { stopReason: "toolUse" })]);
	return {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			capture(JSON.stringify(context));
			return faux.streamSimple(model, context, options);
		},
	};
}

it("uses saved journal, energy and local clock for AI schedule and validates the saved result", async () => {
	const plannerFile = path.join(dir, "generate.json");
	checkInPlannerHabit({ date, energyScore: 2, journalText: journal }, { plannerFile, now });
	let prompt = "";
	const result = await generatePlannerSchedule({
		mode: "llm", date, plannerFile, now,
		engineOverride: fakeEngine("submit_daily_plan", {
			coachSummary: "Lịch học.", minDailyStudyHours: 2, quotas: [],
			blocks: [
				{ startTime: "09:00", endTime: "10:00", type: "study", subject: "Giải tích", title: "Buổi sáng" },
				{ startTime: "16:15", endTime: "17:00", type: "study", subject: "Giải tích", title: "Ôn nhẹ" },
			],
		}, (s) => { prompt = s; }),
	});
	assert.match(prompt, /15:51/);
	assert.match(prompt, /thủ dâm/);
	assert.match(prompt, /energyScore/);
	assert.match(prompt, /calibratedLearningCapacity/);
	assert.ok(result.snapshot.plan.blocks.every((b) => b.startMin >= 15 * 60 + 51));
	assert.ok(!result.snapshot.plan.blocks.some((b) => b.title === "Buổi sáng"));
	assert.deepEqual(readPlannerSnapshot({ plannerFile, date, now }).plan.blocks, result.snapshot.plan.blocks);
});

it("clips Coach's ongoing blocks, removes elapsed ones, and reports the actual saved plan", async () => {
	const plannerFile = path.join(dir, "coach.json");
	checkInPlannerHabit({ date, energyScore: 2, journalText: journal }, { plannerFile, now });
	let prompt = "";
	const result = await chatWithPlannerCoachServer({
		date, plannerFile, now, message: "Mình mệt, giúp sửa lịch hôm nay",
		engineOverride: fakeEngine("submit_coach_response", {
			reply: "Đã xếp 09:00–10:00 và 15:30–16:15.", shouldApplyChanges: true,
			regenerateTodaySchedule: true, changesSummary: "Lịch mới",
			todayOverridePatch: { blocks: [
				{ startTime: "09:00", endTime: "10:00", type: "study", title: "Buổi sáng" },
				{ startTime: "15:30", endTime: "16:15", type: "study", title: "Đang học", subject: "Giải tích" },
				{ startTime: "18:30", endTime: "19:15", type: "study", title: "Đè bữa tối" },
				{ startTime: "23:40", endTime: "02:00", type: "study", title: "Đè giờ ngủ" },
			] },
		}, (s) => { prompt = s; }),
	});
	assert.match(prompt, /15:51/);
	assert.match(prompt, /thủ dâm/);
	assert.match(prompt, /energyScore/);
	assert.ok(result.snapshot.plan.blocks.every((b) => b.startMin >= 15 * 60 + 51));
	assert.equal(result.snapshot.plan.blocks.find((b) => b.title === "Đang học")?.startTime, "15:51");
	assert.ok(!result.snapshot.plan.blocks.some((b) => b.title === "Buổi sáng"));
	assert.ok(!result.snapshot.plan.blocks.some((b) => b.title === "Đè bữa tối" || b.title === "Đè giờ ngủ"));
	assert.ok(result.snapshot.plan.blocks.some((b) => b.type === "meal" && b.startTime === "18:30"));
	assert.doesNotMatch(result.assistantMessage.text, /Đã xếp 09:00/);
	assert.match(result.assistantMessage.text, /15:51/);
	assert.deepEqual(readPlannerSnapshot({ plannerFile, date, now }).plan.blocks, result.snapshot.plan.blocks);
});

it("passes raw journal to the auditor while preserving editable manual entries", async () => {
	const plannerFile = path.join(dir, "audit.json");
	const manual = { id: "manual-1", startTime: "10:00", endTime: "10:30", category: "rest" as const, title: "Nghỉ", minutes: 30, source: "manual" as const };
	let prompt = "";
	const result = await evaluateDailyJournalServer({
		date, plannerFile, now, mode: "llm", discreet: true, journalText: journal, manualEntries: [manual],
		engineOverride: fakeEngine("submit_journal_evaluation", {
			adherencePct: 50, actualStudyMin: 0, summary: "Đã ghi lại", strengths: [], frictionPoints: [], nextDayAdvice: "Nghỉ ngơi",
			entries: [{ startTime: "10:00", endTime: "10:30", category: "rest", title: "Nghỉ", minutes: 30 }],
		}, (s) => { prompt = s; }),
	});
	assert.match(prompt, /thủ dâm/);
	assert.equal(result.snapshot.config.logs[date]?.journalText, journal);
	assert.deepEqual(result.snapshot.config.logs[date]?.actualEntries?.filter((e) => e.source === "manual"), [manual]);
	assert.equal(result.snapshot.config.logs[date]?.actualEntries?.length, 1);
});

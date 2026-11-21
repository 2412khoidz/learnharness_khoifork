import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { checkInPlannerHabit, chatWithPlannerCoachServer, evaluateDailyJournalServer, generatePlannerSchedule, readPlannerSnapshot, savePlannerConfig } from "../src/server/planner.ts";

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

it("archives the elapsed part of a saved plan before AI replanning", async () => {
	const plannerFile = path.join(dir, "archived-plan.json");
	const morning = new Date(2026, 10, 16, 9).getTime();
	const initial = readPlannerSnapshot({ plannerFile, date, now: morning });
	const old = { ...initial.plan, generatedAt: new Date(morning).toISOString(), plannedStudyHours: 1, blocks: [{ id: "prior-study", date, type: "study" as const, title: "Previous study", startTime: "10:00", endTime: "11:00", startMin: 600, endMin: 660, durationMin: 60 }] };
	savePlannerConfig({ ...initial.config, plans: { ...initial.config.plans, [date]: old } }, plannerFile);
	const result = await generatePlannerSchedule({ mode: "llm", date, plannerFile, now, engineOverride: fakeEngine("submit_daily_plan", { coachSummary: "A fresh plan.", minDailyStudyHours: 0, quotas: [], blocks: [] }, () => {}) });
	assert.equal(result.snapshot.config.planHistory?.[date]?.[0]?.plan.blocks[0]?.id, "prior-study");
	const audit = await evaluateDailyJournalServer({ plannerFile, date, now, mode: "local", journalText: "" });
	assert.equal(audit.report.plannedStudyMin, 60);
	assert.equal(audit.report.scorable, true);
});

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
	// Explicitly timed journal entries remain visible alongside the manual entry.
	assert.equal(result.snapshot.config.logs[date]?.actualEntries?.length, 4);
});

it("does not invent a timeline or study minutes from untimed journal text", async () => {
	const plannerFile = path.join(dir, "audit-untimed.json");
	const result = await evaluateDailyJournalServer({
		date, plannerFile, now, mode: "llm", journalText: "Hôm nay thấy mệt", manualEntries: [],
		engineOverride: fakeEngine("submit_journal_evaluation", { adherencePct: 100, actualStudyMin: 60, summary: "Đã học", strengths: [], frictionPoints: [], nextDayAdvice: "Nghỉ", entries: [{ startTime: "08:00", endTime: "09:00", category: "study", title: "Học", minutes: 60 }] }, () => {}),
	});
	assert.equal(result.parsedEntries.length, 0);
	assert.equal(result.report.actualStudyMin, 0);
});

it("extracts clock points from a natural journal while rejecting unsupported times", async () => {
	const plannerFile = path.join(dir, "audit-natural.json");
	const journalText = "Sáng dậy 7h40, sinh hoạt tới 8r rồi ăn sáng đến 10h; sau đó nghỉ tới 10h40.";
	const result = await evaluateDailyJournalServer({
		date, plannerFile, now, mode: "llm", journalText,
		engineOverride: fakeEngine("submit_journal_evaluation", { adherencePct: 0, actualStudyMin: 0, summary: "Đã ghi nhận", strengths: [], frictionPoints: [], nextDayAdvice: "Nghỉ", entries: [
			{ startTime: "07:40", endTime: "08:30", category: "other", title: "Sinh hoạt", minutes: 50 },
			{ startTime: "08:30", endTime: "10:00", category: "meal", title: "Ăn sáng", minutes: 90 },
			{ startTime: "10:00", endTime: "10:20", category: "study", title: "Không có trong nhật ký", minutes: 20 },
		] }, () => {}),
	});
	assert.deepEqual(result.parsedEntries.map((entry) => `${entry.startTime}-${entry.endTime}`), ["07:40-08:30", "08:30-10:00"]);
	assert.equal(result.snapshot.config.logs[date]?.journalText, journalText);
	const local = await evaluateDailyJournalServer({ date, plannerFile, now, mode: "local", journalText });
	assert.equal(local.parsedEntries.length, 2, "saved AI entries remain available on later local audits");
	const changed = await evaluateDailyJournalServer({ date, plannerFile, now, mode: "local", journalText: "A different untimed entry." });
	assert.equal(changed.parsedEntries.length, 0, "changed text must not retain stale extracted intervals");
});

it("preserves AI/Coach plans across snapshot reloads & metadata edits, and clears old customBlocks on fresh Plan with AI", async () => {
	const plannerFile = path.join(dir, "preserve-ai-plan.json");
	const examPrepFile = path.join(dir, "preserve-ai-exams.json");
	const { writeExamPrepConfig } = await import("../src/server/exam-prep.ts");
	writeExamPrepConfig({ mode: "exam", upsertExam: { id: "ex_1", title: "OLP 1", date: "2026-11-28", clusterIds: [] } }, examPrepFile);

	// 1. Coach emits explicit blocks at 16:10..18:25
	const coachRes = await chatWithPlannerCoachServer({
		date, plannerFile, examPrepFile, now, message: "Chiều làm lab rồi học đại số và giải tích",
		engineOverride: fakeEngine("submit_coach_response", {
			reply: "Đã xếp đủ 3 phiên.", shouldApplyChanges: true, regenerateTodaySchedule: true, changesSummary: "3 phiên chiều",
			todayOverridePatch: {
				focusSubjects: ["Nghiên cứu lab", "Dạy đại số", "Dạy giải tích"],
				blocks: [
					{ startTime: "16:10", endTime: "17:00", type: "study", subject: "Nghiên cứu lab", title: "Nghiên cứu lab — Bài 2" },
					{ startTime: "17:10", endTime: "17:45", type: "study", subject: "Dạy đại số", title: "Đại số Olympic" },
				],
			},
		}, () => {}),
	});
	const savedCoachTitles = coachRes.snapshot.plan.blocks.filter((b) => b.type === "study").map((b) => b.title);
	assert.deepEqual(savedCoachTitles, ["Nghiên cứu lab — Bài 2", "Đại số Olympic"]);

	// 2. Background Exam Prep profile change + readPlannerSnapshot must NOT wipe the saved Coach plan
	writeExamPrepConfig({ upsertExam: { id: "ex_2", title: "Cơ sở toán", date: "2026-12-03", clusterIds: [] } }, examPrepFile);
	const afterReload = readPlannerSnapshot({ plannerFile, examPrepFile, date, now });
	assert.deepEqual(
		afterReload.plan.blocks.filter((b) => b.type === "study").map((b) => b.title),
		savedCoachTitles,
	);
	assert.ok(afterReload.config.milestones.some((m) => m.examProfileId === "ex_2"));

	// 3. Metadata patch (pinning a subject / editing milestones) preserves the Coach/AI plan
	const afterMetaPatch = await import("../src/server/planner.ts").then((m) =>
		m.patchPlannerConfig({ pinnedSubjects: ["Dạy đại số"] }, { plannerFile, examPrepFile, now }),
	);
	assert.deepEqual(
		afterMetaPatch.plan.blocks.filter((b) => b.type === "study").map((b) => b.title),
		savedCoachTitles,
	);

	// 4. Clicking Plan with AI replaces stale Coach customBlocks cleanly instead of keeping old blocks
	const aiRes = await generatePlannerSchedule({
		mode: "llm", date, plannerFile, examPrepFile, now,
		engineOverride: fakeEngine("submit_daily_plan", {
			coachSummary: "Kế hoạch AI mới.", minDailyStudyHours: 1,
			quotas: [{ subject: "Giải tích", targetMin: 60, checklist: ["Ôn Rolle"] }],
			blocks: [{ startTime: "20:00", endTime: "21:00", type: "study", subject: "Giải tích", title: "Phiên AI mới" }],
		}, () => {}),
	});
	assert.equal(aiRes.snapshot.config.dayOverrides?.[date]?.customBlocks, undefined);
	assert.deepEqual(aiRes.snapshot.plan.blocks.filter((b) => b.type === "study").map((b) => b.title), ["Phiên AI mới"]);
	assert.deepEqual(readPlannerSnapshot({ plannerFile, examPrepFile, date, now }).plan.blocks.filter((b) => b.type === "study").map((b) => b.title), ["Phiên AI mới"]);
});

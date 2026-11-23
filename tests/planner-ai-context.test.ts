import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { journalWakeForDate } from "../src/core/planner.ts";
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

it("auto-formats freeform prose journal in place via AI Auditor while respecting Discreet Mode and opt-out", async () => {
	const plannerFile = path.join(dir, "audit-format-in-place.json");
	const eveningNow = new Date(2026, 10, 16, 18, 0).getTime();
	const rawBlob =
		"hôm nay tôi dậy từ 8h, 9h ăn sáng, 10r ăn cơm, sau đó call người yêu từ 11r đến 13h30, rồi lại thủ dâm đến 14h25, rồi ngủ đến 15h30, sau đó 17h học đến 17h45 môn Biểu diễn tri thức";
	const aiFormatted = [
		"08:00 : Dậy",
		"09:00 : Ăn sáng",
		"10:30 : Ăn cơm",
		"11:30 - 13:30 : Gọi điện người yêu",
		"13:30 - 14:25 : Thủ dâm",
		"14:25 - 15:30 : Ngủ trưa",
		"17:00 - 17:45 : Học Biểu diễn tri thức",
	].join("\n");

	let capturedPrompt = "";
	const res = await evaluateDailyJournalServer({
		date,
		plannerFile,
		now: eveningNow,
		mode: "llm",
		discreet: true,
		journalText: rawBlob,
		engineOverride: fakeEngine(
			"submit_journal_evaluation",
			{
				adherencePct: 60,
				actualStudyMin: 45,
				summary: "Học được một ca chiều.",
				strengths: ["Hoàn thành ca học chiều"],
				frictionPoints: [],
				nextDayAdvice: "Giữ nhịp tối.",
				entries: [
					{ startTime: "11:30", endTime: "13:30", category: "other", title: "Gọi điện người yêu", minutes: 120 },
					{ startTime: "13:30", endTime: "14:25", category: "other", title: "Thủ dâm", minutes: 55 },
					{ startTime: "14:25", endTime: "15:30", category: "sleep", title: "Ngủ trưa", minutes: 65 },
					{ startTime: "17:00", endTime: "17:45", category: "study", subject: "Biểu diễn tri thức", title: "Học Biểu diễn tri thức", minutes: 45 },
				],
				formattedJournal: aiFormatted,
			},
			(p) => {
				capturedPrompt = p;
			},
		),
	});

	assert.match(capturedPrompt, /thủ dâm/, "raw journal is passed to the AI auditor");
	assert.equal(res.formattedJournalApplied, true);
	const savedText = res.snapshot.config.logs[date]?.journalText ?? "";
	assert.equal(
		savedText,
		[
			"08:00 : Dậy",
			"09:00 : Ăn sáng",
			"10:30 : Ăn cơm",
			"11:30 - 13:30 : Gọi điện người yêu",
			"13:30 - 14:25 : [private]",
			"14:25 - 15:30 : Ngủ trưa",
			"17:00 - 17:45 : Học Biểu diễn tri thức",
		].join("\n"),
	);
	assert.equal(journalWakeForDate(res.snapshot.config.logs, date)?.time, "08:00");

	const localFollowUp = await evaluateDailyJournalServer({
		date,
		plannerFile,
		now: eveningNow,
		mode: "local",
		journalText: savedText,
	});
	assert.equal(localFollowUp.formattedJournalApplied, false);
	assert.ok(localFollowUp.parsedEntries.some((e) => e.startTime === "17:00" && e.endTime === "17:45" && e.category === "study"));

	const optOut = await evaluateDailyJournalServer({
		date,
		plannerFile,
		now: eveningNow,
		mode: "llm",
		discreet: true,
		formatJournal: false,
		journalText: rawBlob,
		engineOverride: fakeEngine(
			"submit_journal_evaluation",
			{
				adherencePct: 60,
				actualStudyMin: 45,
				summary: "OK",
				strengths: [],
				frictionPoints: [],
				nextDayAdvice: "Keep going",
				entries: [
					{ startTime: "17:00", endTime: "17:45", category: "study", subject: "Biểu diễn tri thức", title: "Học Biểu diễn tri thức", minutes: 45 },
				],
				formattedJournal: aiFormatted,
			},
			() => {},
		),
	});
	assert.equal(optOut.formattedJournalApplied, false);
	assert.equal(optOut.snapshot.config.logs[date]?.journalText, rawBlob);
});

it("feeds server presence-log.json + chat bursts into signals.autoDraftItems and syncs Quick Switcher across Mobile Companion", async () => {
	const dataDir = path.join(dir, "mobile-auto-draft");
	const chatsDir = path.join(dataDir, "chats");
	fs.mkdirSync(chatsDir, { recursive: true });
	const plannerFile = path.join(dataDir, "planner.json");
	const examPrepFile = path.join(dataDir, "exam-prep.json");
	const flashcardsFile = path.join(dataDir, "flashcards.json");

	const d = "2026-11-16";
	const tMorning = new Date(2026, 10, 16, 9, 0).getTime();
	const tEndChat = new Date(2026, 10, 16, 9, 40).getTime();
	const eveningNow = new Date(2026, 10, 16, 18, 0).getTime();

	fs.writeFileSync(
		path.join(chatsDir, "c_ds.json"),
		JSON.stringify({
			id: "c_ds",
			title: "Đại số tuyến tính",
			updatedAt: new Date(tEndChat).toISOString(),
			messages: [
				{ role: "user", timestamp: tMorning, content: [{ type: "text", text: "Bắt đầu" }] },
				{ role: "assistant", timestamp: tEndChat, content: [{ type: "text", text: "Xong" }] },
			],
		}),
	);
	fs.writeFileSync(
		path.join(dataDir, "presence-log.json"),
		JSON.stringify({
			version: 1,
			days: {
				[d]: {
					firstActiveAt: "08:10",
					lastActiveAt: "17:55",
					awayIntervals: [{ startTime: "12:15", endTime: "13:05", reason: "sleep" }],
				},
			},
		}),
	);

	const snap = readPlannerSnapshot({ plannerFile, examPrepFile, flashcardsFile, chatsDir, date: d, now: eveningNow });
	assert.ok((snap.signals.autoDraftItems?.length ?? 0) >= 3);
	assert.ok(snap.signals.autoDraftItems?.some((item) => item.source === "presence_wake" && item.startTime === "08:10"));
	assert.ok(snap.signals.autoDraftItems?.some((item) => item.source === "session" && item.startTime === "09:00" && item.endTime === "09:40"));
	assert.ok(snap.signals.autoDraftItems?.some((item) => item.source === "presence_away" && item.startTime === "12:15" && item.endTime === "13:05"));

	const { buildMobileCompanionPlannerView, updateMobileCompanionPlannerCheckIn } = await import("../src/server/phone-companion.ts");
	const initialMob = buildMobileCompanionPlannerView({ plannerFile, examPrepFile, flashcardsFile, chatsDir, now: eveningNow });
	assert.ok((initialMob.autoDraftCount ?? 0) >= 3);
	assert.ok(initialMob.autoDraftLines?.includes("09:00 - 09:40 : Học Đại số tuyến tính"));

	const afterStart = await updateMobileCompanionPlannerCheckIn(
		{ date: d, switchActivity: { label: "Nghiên cứu / Lab", category: "study" } },
		{ plannerFile, examPrepFile, flashcardsFile, chatsDir, now: new Date(2026, 10, 16, 16, 0).getTime() },
	);
	assert.equal(afterStart.planner.todayLog?.activeActivity?.label, "Nghiên cứu / Lab");

	const afterStop = await updateMobileCompanionPlannerCheckIn(
		{ date: d, switchActivity: null },
		{ plannerFile, examPrepFile, flashcardsFile, chatsDir, now: new Date(2026, 10, 16, 16, 50).getTime() },
	);
	assert.equal(afterStop.planner.todayLog?.activeActivity, undefined);
	assert.ok(afterStop.planner.todayLog?.journalText?.includes("16:00 - 16:50 : Nghiên cứu / Lab"));
});

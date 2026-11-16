import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-planner-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

import {
	applyHabitCheckIn,
	applyLlmPlanOutput,
	buildCompactPlannerDigest,
	buildMonthGridDates,
	computeExamPrepStatus,
	computeHabitStrengthSummary,
	computeLocalPlannerPlan,
	computeLoopHabitStep,
	computeSleepAnchorForDate,
	computeSubjectPaceMultiplier,
	DEFAULT_EXAM_PREP_CONFIG,
	DEFAULT_PLANNER_CONFIG,
	emptyGraphFsrsSummary,
	optimizeSlotAssignments,
	parseIcsWeeklyEvents,
	parseLocalSyllabusOutline,
	parseSimpleWeeklyText,
	resolveActiveBlockStatus,
	sanitizePlannerConfig,
	type PlannerConfig,
	type PlannerPersonalSignals,
} from "../src/core/index.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { buildMobileHtml } from "../src/server/phone-mobile-ui.ts";
import {
	buildLinkedClusterContext,
	checkInPlannerHabit,
	closePhoneUploadSession,
	createPhoneUploadSession,
	extractPlannerMaterialFile,
	generatePlannerSchedule,
	getMobileCompanionState,
	patchPlannerConfig,
	parseWeeklyScheduleInput,
	readPlannerSnapshot,
	researchExamSyllabus,
	writeExamPrepConfig,
} from "../src/server/index.ts";

function fakeSubmitEngine(toolName: string, args: unknown): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall(toolName, args as ToolCall["arguments"], { id: "tc_1" })],
			{ stopReason: "toolUse" },
		),
	]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

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

describe("Study Planner core logic", () => {
	it("gradually pulls late-night skewed sleep earlier without impossible jumps", () => {
		const step1 = computeSleepAnchorForDate(
			{
				currentBedtime: "03:30",
				targetBedtime: "23:30",
				targetSleepHours: 7.5,
				shiftStepMinPerDay: 30,
				peakFocusWindow: "auto",
			},
			{},
			"2026-11-16",
			"healthy",
		);
		assert.equal(step1.tonightBedMin % 1440, 3 * 60); // 03:00
		assert.ok(step1.advice.includes("03:00"));
		assert.ok(step1.daysToTarget >= 6);

		// Logging on-track bedtime advances the shift cleanly next day
		const step2 = computeSleepAnchorForDate(
			{
				currentBedtime: "03:30",
				targetBedtime: "23:30",
				targetSleepHours: 7.5,
				shiftStepMinPerDay: 30,
				peakFocusWindow: "auto",
			},
			{
				"2026-11-16": {
					date: "2026-11-16",
					actualBedtime: "03:00",
					completedBlockIds: [],
					completedChecklistIds: [],
					loggedStudyMinBySubject: {},
					hobbyDone: true,
					mealsOk: true,
				},
			},
			"2026-11-17",
			"healthy",
		);
		assert.equal(step2.tonightBedMin % 1440, 2 * 60 + 30); // 02:30
	});

	it("allocates balanced multi-subject quotas, avoids fixed classes, and scales with intensity", () => {
		const baseConfig: PlannerConfig = sanitizePlannerConfig({
			...DEFAULT_PLANNER_CONFIG,
			intensity: "healthy",
			fixedEvents: [
				{ id: "f1", dayOfWeek: "mon", startTime: "07:30", endTime: "10:30", title: "Xác suất thống kê", category: "class" },
			],
			milestones: [
				{
					id: "m_calc",
					kind: "competition",
					title: "Olympic Giải tích",
					subject: "Giải tích",
					dueDate: "2026-11-26",
					priority: 3,
					cognitiveLoad: "heavy",
					clusterIds: ["c_calc"],
					estimatedHours: 24,
					completedHours: 4,
					syllabusTopics: [{ id: "t1", title: "Chuỗi số & Chuỗi hàm", estHours: 6, done: false }],
					notes: "",
				},
				{
					id: "m_os",
					kind: "exam",
					title: "Midterm Hệ điều hành",
					subject: "Hệ điều hành",
					dueDate: "2026-11-28",
					priority: 2,
					cognitiveLoad: "medium",
					clusterIds: ["c_os"],
					estimatedHours: 14,
					completedHours: 2,
					syllabusTopics: [{ id: "t2", title: "Scheduling & Deadlock", estHours: 4, done: false }],
					notes: "",
				},
			],
			lifestyle: {
				...DEFAULT_PLANNER_CONFIG.lifestyle,
				hobbies: ["Cầu lông", "Anime"],
				dailyHobbyMin: 60,
			},
		});

		const signals = sampleSignals("2026-11-16"); // 2026-11-16 is a Monday!
		const healthyPlan = computeLocalPlannerPlan(baseConfig, signals);
		const intensivePlan = computeLocalPlannerPlan({ ...baseConfig, intensity: "intensive" }, signals);

		// Respects fixed class on Monday without overlapping study blocks inside 07:30-10:30
		const studyBlocks = healthyPlan.blocks.filter((b) => b.type === "study");
		for (const sb of studyBlocks) {
			assert.ok(sb.endMin <= 7 * 60 + 30 || sb.startMin >= 10 * 60 + 30, `Study block ${sb.startTime}-${sb.endTime} overlapped fixed class`);
		}
		assert.ok(healthyPlan.blocks.some((b) => b.type === "fixed" && b.title === "Xác suất thống kê"));
		assert.ok(healthyPlan.blocks.some((b) => b.type === "hobby" && b.title.includes("Cầu lông")));

		// Anti-monopoly: both urgent subjects appear in daily quotas
		const subjects = healthyPlan.quotas.map((q) => q.subject);
		assert.ok(subjects.includes("Giải tích") && subjects.includes("Hệ điều hành"));

		// Includes Graph FSRS + Mistake hints in checklist
		const allChecklistText = healthyPlan.quotas.flatMap((q) => q.checklist.map((c) => c.text)).join("\n");
		assert.ok(allChecklistText.includes("Rolle"), "Expected FSRS/Mistake hint in daily checklist");

		// Intensive mode schedules more study hours than healthy mode
		assert.ok(intensivePlan.plannedStudyHours >= healthyPlan.plannedStudyHours);

		// Switch status triggers softly right after a study block ends
		const firstStudy = studyBlocks[0]!;
		const afterEndMs = new Date(2026, 10, 16, Math.floor(firstStudy.endMin / 60), (firstStudy.endMin % 60) + 2).getTime();
		const activeStatus = resolveActiveBlockStatus(healthyPlan, undefined, afterEndMs);
		assert.ok(activeStatus.recentlyEndedBlock);
		assert.equal(activeStatus.shouldPromptSwitch, true);
	});

	it("parses simple Vietnamese and English TKB lines locally with 0 tokens", () => {
		const parsed = parseSimpleWeeklyText([
			"T2 07:30-09:30 Giải tích hàm nhiều biến",
			"Thứ 4 14h-16h30 CLB Olympic Toán",
			"Sun 09:00-11:00 Side Project Review",
		].join("\n"));

		assert.equal(parsed.length, 3);
		assert.deepEqual(parsed.map((e) => ({ d: e.dayOfWeek, s: e.startTime, e: e.endTime, c: e.category })), [
			{ d: "mon", s: "07:30", e: "09:30", c: "class" },
			{ d: "wed", s: "14:00", e: "16:30", c: "club" },
			{ d: "sun", s: "09:00", e: "11:00", c: "class" },
		]);
	});

	it("guards LLM schedule output against overlapping fixed events", () => {
		const cfg = sanitizePlannerConfig({
			...DEFAULT_PLANNER_CONFIG,
			fixedEvents: [{ id: "f1", dayOfWeek: "mon", startTime: "09:00", endTime: "11:00", title: "Lab", category: "class" }],
		});
		const baseline = computeLocalPlannerPlan(cfg, sampleSignals("2026-11-16"));
		const digest = buildCompactPlannerDigest(cfg, sampleSignals("2026-11-16"), baseline);
		assert.ok(Array.isArray(digest.fixedEventsToday));

		const merged = applyLlmPlanOutput(
			baseline,
			{
				coachSummary: "Prioritize proofs in peak focus hours.",
				minDailyStudyHours: 3.5,
				blocks: [
					// Invalid overlap with Lab (09:00-11:00) -> MUST be rejected
					{ startTime: "09:30", endTime: "10:30", type: "study", subject: "Giải tích", title: "Bad Overlap" },
					// Valid afternoon block -> MUST be kept
					{ startTime: "14:00", endTime: "15:15", type: "study", subject: "Giải tích", title: "Proof drills" },
				],
			},
			cfg,
			"test:model",
		);
		assert.ok(!merged.blocks.some((b) => b.title === "Bad Overlap"));
		assert.ok(merged.blocks.some((b) => b.title === "Proof drills"));
		assert.equal(merged.engineUsed, "llm");
	});

	it("computes Loop smooth habit strength, SleepFlow 90m cycles, and Zeitlog drift cleanly", () => {
		const stepped = computeLoopHabitStep(0.75, 0, 1.0);
		assert.ok(stepped > 0.68 && stepped < 0.75, `Expected gentle <10% decay from 0.75, got ${stepped}`);

		const cfg: PlannerConfig = sanitizePlannerConfig({
			...DEFAULT_PLANNER_CONFIG,
			lifestyle: {
				...DEFAULT_PLANNER_CONFIG.lifestyle,
				sleep: {
					...DEFAULT_PLANNER_CONFIG.lifestyle.sleep,
					currentBedtime: "23:30",
					targetBedtime: "23:15",
				},
			},
			logs: {
				"2026-11-11": { date: "2026-11-11", actualBedtime: "23:20", mealsOk: true, hobbyDone: true, loggedStudyMinBySubject: { Math: 100 }, completedBlockIds: ["b1", "b2"], completedChecklistIds: [] },
				"2026-11-12": { date: "2026-11-12", actualBedtime: "23:25", mealsOk: true, hobbyDone: true, loggedStudyMinBySubject: { Math: 120 }, completedBlockIds: ["b1", "b2"], completedChecklistIds: [] },
				"2026-11-13": { date: "2026-11-13", actualBedtime: "23:15", mealsOk: true, hobbyDone: true, loggedStudyMinBySubject: { Math: 90 }, completedBlockIds: ["b1", "b2"], completedChecklistIds: [] },
				"2026-11-14": { date: "2026-11-14", actualBedtime: "23:30", mealsOk: true, hobbyDone: true, loggedStudyMinBySubject: { Math: 100 }, completedBlockIds: ["b1", "b2"], completedChecklistIds: [] },
			},
		});
		const beforeMiss = computeHabitStrengthSummary(cfg, "2026-11-14");
		const afterOneMissedDay = computeHabitStrengthSummary(cfg, "2026-11-15");
		assert.ok(beforeMiss.overallPct >= 50);
		assert.ok(beforeMiss.overallPct - afterOneMissedDay.overallPct < 10);
		assert.ok(afterOneMissedDay.overallPct > 0);
		assert.equal(afterOneMissedDay.cycleWakeSuggestions.length, 3);
		assert.ok(afterOneMissedDay.circadianDriftMin > 0 && afterOneMissedDay.circadianDriftMin <= 20);
	});

	it("parses RFC 5545 .ics calendars and syllabus outlines locally with 0 tokens", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			"SUMMARY:Olympic Giai ",
			" Tich",
			"DTSTART;TZID=Asia/Ho_Chi_Minh:20261116T073000",
			"DTEND;TZID=Asia/Ho_Chi_Minh:20261116T093000",
			"RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");

		const icsEvents = parseIcsWeeklyEvents(ics);
		assert.equal(icsEvents.length, 2);
		assert.deepEqual(
			icsEvents.map((e) => ({ d: e.dayOfWeek, s: e.startTime, e: e.endTime, t: e.title })),
			[
				{ d: "mon", s: "07:30", e: "09:30", t: "Olympic Giai Tich" },
				{ d: "wed", s: "07:30", e: "09:30", t: "Olympic Giai Tich" },
			],
		);
		assert.equal(parseSimpleWeeklyText(ics).length, 2);

		const outline = parseLocalSyllabusOutline([
			"- Chuỗi số & Chuỗi hàm (6h)",
			"2. Phép tính vi phân - 4 giờ",
			"* Thực hành giải đề 4 tiết",
		].join("\n"));
		assert.equal(outline.syllabusTopics.length, 3);
		assert.equal(outline.estimatedHours, 13);
	});

	it("runs 2-opt slot constraint optimization, DueCue pace adaptation, 7-day forecast, pre-switch warning, and addStudyMin", () => {
		const slots = [
			{ startMin: 480, endMin: 530, isPeak: true, rank: 0 },
			{ startMin: 540, endMin: 590, isPeak: true, rank: 1 },
			{ startMin: 600, endMin: 650, isPeak: false, rank: 2 },
		];
		const heavyA = { subject: "Giải tích", cognitiveLoad: "heavy" as const };
		const mediumB = { subject: "Hệ điều hành", cognitiveLoad: "medium" as const };
		const optimized = optimizeSlotAssignments(slots, [heavyA, heavyA, mediumB], 23 * 60 + 30);
		assert.notEqual(optimized[0]?.subject, optimized[1]?.subject);
		assert.equal(optimized[0]?.subject, "Giải tích");
		assert.equal(optimized[1]?.subject, "Hệ điều hành");

		// DueCue pace multiplier > 1.0 when student spent longer than planned quota on previous day
		const pacedCfg = sanitizePlannerConfig({
			...DEFAULT_PLANNER_CONFIG,
			milestones: [
				{
					id: "m1",
					kind: "exam",
					title: "Midterm",
					subject: "Giải tích",
					dueDate: "2026-11-25",
					priority: 3,
					cognitiveLoad: "heavy",
					clusterIds: [],
					estimatedHours: 20,
					completedHours: 1,
					syllabusTopics: [],
					notes: "",
				},
			],
			plans: {
				"2026-11-15": {
					date: "2026-11-15",
					generatedAt: "2026-11-15T00:00:00Z",
					engineUsed: "local",
					intensity: "balanced",
					minDailyStudyHours: 2,
					plannedStudyHours: 2,
					freeHoursTotal: 6,
					recommendedBedtime: "23:15",
					recommendedWakeTime: "06:45",
					todayWakeTime: "07:00",
					sleepShiftAdvice: "",
					daysToSleepTarget: 0,
					quotas: [{ id: "q1", subject: "Giải tích", targetMin: 60, urgencyScore: 80, checklist: [] }],
					blocks: [],
				},
			},
			logs: {
				"2026-11-15": {
					date: "2026-11-15",
					completedBlockIds: [],
					completedChecklistIds: [],
					loggedStudyMinBySubject: { "Giải tích": 80 },
					hobbyDone: false,
					mealsOk: false,
				},
			},
		});
		const pace = computeSubjectPaceMultiplier("Giải tích", pacedCfg, "2026-11-16");
		assert.ok(pace > 1.25 && pace <= 1.45, `Expected pace > 1.25, got ${pace}`);

		const fullPlan = computeLocalPlannerPlan(pacedCfg, sampleSignals("2026-11-16"));
		assert.equal(fullPlan.weeklyForecast?.length, 7);
		assert.ok(fullPlan.habitStrength);

		// Stretchly 2-minute preSwitchWarning
		const mockSwitchPlan = {
			...fullPlan,
			blocks: [
				{
					id: "b1",
					date: "2026-11-16",
					startTime: "09:00",
					endTime: "09:50",
					startMin: 9 * 60,
					endMin: 9 * 60 + 50,
					durationMin: 50,
					type: "study" as const,
					title: "Giải tích",
					subject: "Giải tích",
					strictSwitch: true,
				},
				{
					id: "b2",
					date: "2026-11-16",
					startTime: "10:00",
					endTime: "10:50",
					startMin: 10 * 60,
					endMin: 10 * 60 + 50,
					durationMin: 50,
					type: "study" as const,
					title: "Hệ điều hành",
					subject: "Hệ điều hành",
					strictSwitch: true,
				},
			],
		};
		const twoMinLeftMs = new Date(2026, 10, 16, 9, 48).getTime();
		const warnStatus = resolveActiveBlockStatus(mockSwitchPlan, undefined, twoMinLeftMs);
		assert.equal(warnStatus.preSwitchWarning, true);
		assert.equal(warnStatus.minutesRemaining, 2);

		// addStudyMin incremental habit check-in
		const withAdded = applyHabitCheckIn(
			{ ...pacedCfg, plans: { ...pacedCfg.plans, "2026-11-16": fullPlan } },
			{ date: "2026-11-16", addStudyMin: { subject: "Giải tích", minutes: 30, milestoneId: "m1" } },
			new Date(2026, 10, 16, 12, 0).getTime(),
		);
		assert.equal(withAdded.logs["2026-11-16"]?.loggedStudyMinBySubject["Giải tích"], 30);
		assert.equal(withAdded.milestones[0]?.completedHours, 1.5);

		// Month grid builder & dayOverrides support for interactive Google-Calendar-style editing
		const novGrid = buildMonthGridDates(2026, 10); // November 2026
		assert.equal(novGrid.length, 42);
		assert.equal(novGrid.filter((c) => c.inMonth).length, 30);

		const ovCfg = sanitizePlannerConfig({
			...pacedCfg,
			fixedEvents: [{ id: "f1", dayOfWeek: "mon", startTime: "08:00", endTime: "10:00", title: "Weekly Class", category: "class" }],
			dayOverrides: {
				"2026-11-16": {
					date: "2026-11-16",
					skipFixedEvents: true,
					extraBusyEvents: [{ id: "e1", startTime: "07:30", endTime: "11:00", title: "Olympic Contest", category: "other" }],
					studyTargetHoursOverride: 0,
					note: "Exam morning",
				},
			},
		});
		const ovPlan = computeLocalPlannerPlan(ovCfg, sampleSignals("2026-11-16"));
		assert.ok(!ovPlan.blocks.some((b) => b.title === "Weekly Class"));
		assert.ok(ovPlan.blocks.some((b) => b.title === "Olympic Contest"));
		assert.equal(ovPlan.plannedStudyHours, 0);
	});
});

describe("Study Planner server AI workflows & Mobile Companion sync", () => {
	it("runs 1-shot AI coach, multimodal TKB parser, and exam syllabus researcher cleanly", async () => {
		const dir = fs.mkdtempSync(path.join(TMP_DATA, "srv-"));
		const plannerFile = path.join(dir, "planner.json");
		const examPrepFile = path.join(dir, "exam-prep.json");

		patchPlannerConfig(
			{
				milestones: [
					{
						id: "m1",
						kind: "competition",
						title: "Olympic Giải tích",
						subject: "Giải tích",
						dueDate: "2026-11-25",
						priority: 3,
						cognitiveLoad: "heavy",
						clusterIds: [],
						estimatedHours: 20,
						completedHours: 0,
						syllabusTopics: [],
						notes: "",
					},
				],
			},
			{ plannerFile, examPrepFile, now: Date.UTC(2026, 10, 16, 8, 0) },
		);

		const coachRes = await generatePlannerSchedule({
			mode: "llm",
			date: "2026-11-16",
			plannerFile,
			examPrepFile,
			now: new Date(2026, 10, 16, 8, 0).getTime(),
			engineOverride: fakeSubmitEngine("submit_daily_plan", {
				coachSummary: "Tập trung giải đề Olympic buổi sáng khi tỉnh táo.",
				minDailyStudyHours: 4,
				quotas: [{ subject: "Giải tích", targetMin: 120, checklist: ["Làm 3 bài giới hạn dãy số"] }],
				blocks: [
					{ startTime: "08:30", endTime: "09:45", type: "study", subject: "Giải tích", title: "Olympic Limits", cognitiveLoad: "heavy" },
					{ startTime: "20:00", endTime: "21:00", type: "hobby", title: "Chơi cầu lông" },
				],
			}),
		});
		assert.equal(coachRes.snapshot.plan.engineUsed, "llm");
		assert.ok(coachRes.snapshot.plan.coachSummary?.includes("Olympic"));

		// Test multimodal TKB image extraction
		const tkb = await parseWeeklyScheduleInput({
			rawText: "Kèm ảnh TKB kỳ 1",
			images: [{ type: "image", data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" }],
			engineOverride: fakeSubmitEngine("submit_weekly_schedule", {
				events: [{ dayOfWeek: "tue", startTime: "08:00", endTime: "10:00", title: "Cấu trúc dữ liệu", category: "class" }],
			}),
		});
		assert.equal(tkb.used, "ai");
		assert.equal(tkb.events[0]?.dayOfWeek, "tue");

		// Test 1-shot Exam syllabus researcher
		const researched = await researchExamSyllabus({
			title: "Olympic Toán Giải tích Sinh viên",
			kind: "competition",
			engineOverride: fakeSubmitEngine("submit_exam_syllabus", {
				subject: "Olympic Giải tích",
				cognitiveLoad: "heavy",
				priority: 3,
				estimatedHours: 36,
				syllabusTopics: [
					{ title: "Dãy số & Giới hạn", estHours: 10 },
					{ title: "Phép tính vi phân & Định lý giá trị trung bình", estHours: 14 },
					{ title: "Tích phân & Bất đẳng thức tích phân", estHours: 12 },
				],
				sourceSummary: "Chuẩn đề cương thi Olympic Toán SV bảng A/B.",
			}),
		});
		assert.equal(researched.syllabusTopics.length, 3);
		assert.equal(researched.estimatedHours, 36);

		// Test habit check-in persistence
		const studyBlock = coachRes.snapshot.plan.blocks.find((b) => b.type === "study")!;
		const afterCheckIn = checkInPlannerHabit(
			{ date: "2026-11-16", toggleBlockId: studyBlock.id, mealsOk: true, hobbyDone: true, actualBedtime: "02:30", energyScore: 4 },
			{ plannerFile, examPrepFile },
		);
		assert.ok(afterCheckIn.config.logs["2026-11-16"]?.completedBlockIds.includes(studyBlock.id));
		assert.equal(afterCheckIn.config.logs["2026-11-16"]?.mealsOk, true);
	});

	it("syncs Today's Plan & habit check-ins to Mobile Companion and keeps valid ES5 HTML", async () => {
		const dir = fs.mkdtempSync(path.join(TMP_DATA, "mob-"));
		const plannerFile = path.join(dir, "planner.json");
		const examPrepFile = path.join(dir, "exam-prep.json");
		const flashcardsFile = path.join(dir, "flashcards.json");
		const chatsDir = path.join(dir, "chats");
		fs.mkdirSync(chatsDir, { recursive: true });

		patchPlannerConfig(
			{
				milestones: [
					{
						id: "m_olympic",
						kind: "competition",
						title: "Olympic Tin học",
						subject: "Thuật toán",
						dueDate: "2026-11-28",
						priority: 3,
						cognitiveLoad: "heavy",
						clusterIds: [],
						estimatedHours: 25,
						completedHours: 2,
						syllabusTopics: [],
						notes: "",
					},
				],
			},
			{ plannerFile, examPrepFile },
		);

		const state = getMobileCompanionState({ plannerFile, examPrepFile, flashcardsFile, chatsDir });
		assert.ok(state.planner);
		assert.equal(state.planner.upcomingMilestones[0]?.title, "Olympic Tin học");

		// Live HTTP check-in via mobile companion server
		const session = await createPhoneUploadSession({
			attachmentsDir: dir,
			flashcardsFile,
			examPrepFile,
			plannerFile,
			chatsDir,
			interfaces: { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] },
		});
		try {
			const res = await fetch(`http://127.0.0.1:${session.port}/p/${session.token}/companion/planner-checkin`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					date: state.planner.date,
					hobbyDone: true,
					mealsOk: true,
					actualBedtime: "01:45",
					energyScore: 4,
				}),
			});
			assert.equal(res.status, 200);
			const body = (await res.json()) as {
				ok: boolean;
				planner: { todayLog: { hobbyDone: boolean; mealsOk: boolean; actualBedtime?: string; energyScore?: number } };
			};
			assert.equal(body.ok, true);
			assert.equal(body.planner.todayLog.hobbyDone, true);
			assert.equal(body.planner.todayLog.mealsOk, true);
			assert.equal(body.planner.todayLog.actualBedtime, "01:45");
			assert.equal(body.planner.todayLog.energyScore, 4);
		} finally {
			await closePhoneUploadSession();
		}

		// Verify mobile UI still parses cleanly as valid ES5 JS, exposes bedtime & energy controls, and has zero literal https://
		const html = buildMobileHtml("http://127.0.0.1:4321/p/tok/upload");
		assert.equal(html.includes("https://"), false);
		assert.ok(html.includes('id="mob-bedtime"'));
		assert.ok(html.includes('id="mob-energy-strip"'));
		const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
		assert.ok(scriptMatch?.[1]);
		assert.doesNotThrow(() => new vm.Script(scriptMatch![1]!));
		const snapCheck = readPlannerSnapshot({ plannerFile, examPrepFile });
		assert.equal(snapCheck.config.logs[state.planner.date]?.hobbyDone, true);
		assert.equal(snapCheck.config.logs[state.planner.date]?.actualBedtime, "01:45");
		assert.equal(snapCheck.config.logs[state.planner.date]?.energyScore, 4);

		// Test 0-token local outline syllabus parser in researchExamSyllabus
		const localSyllabus = await researchExamSyllabus({
			title: "Olympic Tin học",
			kind: "competition",
			preferLocal: true,
			materialsText: "- Quy hoạch động (6h)\n- Đồ thị nâng cao 8h",
		});
		assert.equal(localSyllabus.modelLabel, "local:outline-parser");
		assert.equal(localSyllabus.usedWebSearch, false);
		assert.equal(localSyllabus.estimatedHours, 14);
	});

	it("auto-syncs Exam Prep profiles, pulls linked chat/tree/notes context, and extracts uploaded materials", async () => {
		const dir = fs.mkdtempSync(path.join(TMP_DATA, "sync-"));
		const plannerFile = path.join(dir, "planner.json");
		const examPrepFile = path.join(dir, "exam-prep.json");
		const chatsDir = path.join(dir, "chats");
		fs.mkdirSync(chatsDir, { recursive: true });

		const chatId = "chat_calc_olympic";
		fs.writeFileSync(
			path.join(chatsDir, `${chatId}.json`),
			JSON.stringify({
				id: chatId,
				title: "Dạy giải tích olympic sinh viên",
				createdAt: "2026-11-10T00:00:00Z",
				updatedAt: "2026-11-16T08:00:00Z",
				notes: "Trọng tâm: dãy truy hồi, tích phân suy rộng",
				tree: {
					version: 1,
					nodes: [
						{ id: "n1", title: "Giới hạn dãy số & Stolz-Cesaro" },
						{ id: "n2", title: "Định lý giá trị trung bình Rolle/Lagrange" },
					],
					edges: [],
				},
				messages: [],
			}),
			"utf8",
		);

		writeExamPrepConfig(
			{
				upsertExam: {
					id: "ex_olympic_1",
					title: "Olympic sinh viên giải tích Vòng 1",
					date: "2026-12-05",
					pace: "efficient",
					clusterIds: [chatId],
				},
			},
			examPrepFile,
		);

		const snap = readPlannerSnapshot({ plannerFile, examPrepFile, chatsDir });
		const synced = snap.config.milestones.find((m) => m.examProfileId === "ex_olympic_1");
		assert.ok(synced, "Expected Exam Prep profile to sync automatically into milestones & calendar");
		assert.equal(synced.dueDate, "2026-12-05");
		assert.equal(synced.kind, "competition");

		const ctx = buildLinkedClusterContext({ examProfileId: "ex_olympic_1", examPrepFile, chatsDir });
		assert.ok(ctx.summaryText.includes("Stolz-Cesaro"));
		assert.ok(ctx.summaryText.includes("dãy truy hồi"));
		assert.equal(ctx.topicHints.length, 2);

		const pulled = await researchExamSyllabus({
			title: "",
			kind: "competition",
			examProfileId: "ex_olympic_1",
			pullOnly: true,
			examPrepFile,
			chatsDir,
		});
		assert.equal(pulled.syllabusTopics.length, 2);
		assert.ok(pulled.pulledContext?.includes("Rolle/Lagrange"));

		// Dismissing synced milestone remembers dismissal until re-synced
		const afterDismiss = patchPlannerConfig({ milestones: [] }, { plannerFile, examPrepFile, chatsDir });
		assert.ok(afterDismiss.config.dismissedExamProfileIds?.includes("ex_olympic_1"));
		const afterResync = patchPlannerConfig({ dismissedExamProfileIds: [] }, { plannerFile, examPrepFile, chatsDir });
		assert.ok(afterResync.config.milestones.some((m) => m.examProfileId === "ex_olympic_1"));

		// Material extractor handles Markdown text cleanly
		const mdExtracted = await extractPlannerMaterialFile("syllabus.md", Buffer.from("# Chương 1\n- Tích phân"));
		assert.ok(mdExtracted.text.includes("Chương 1"));
	});
});

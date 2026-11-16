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
	clipPreservingLatex,
	computeExamPrepStatus,
	computeHabitStrengthSummary,
	computeLearningCapacityReport,
	computeLocalPlannerPlan,
	computeLoopHabitStep,
	computePersonalizedMilestoneEstimate,
	computeSleepAnchorForDate,
	computeSubjectPaceMultiplier,
	DEFAULT_EXAM_PREP_CONFIG,
	DEFAULT_PLANNER_CONFIG,
	emptyGraphFsrsSummary,
	evaluatePlanVsActualLocal,
	formatPlainMathPreview,
	optimizeSlotAssignments,
	parseIcsWeeklyEvents,
	parseJournalTextLocal,
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
	buildPlannerPersonalSignals,
	calibratePlannerFromCapacityServer,
	chatWithPlannerCoachServer,
	checkInPlannerHabit,
	clearPlannerCoachChatServer,
	closePhoneUploadSession,
	createPhoneUploadSession,
	diagnoseLearningCapacityWithAiServer,
	estimateMilestoneWorkloadServer,
	evaluateDailyJournalServer,
	extractPlannerMaterialFile,
	generatePlannerSchedule,
	getMobileCompanionState,
	patchPlannerConfig,
	parseWeeklyScheduleInput,
	readPlannerLearningCapacityServer,
	readPlannerSnapshot,
	researchExamSyllabus,
	suggestLifestyleBalanceServer,
	undoPlannerCoachChangeServer,
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

	it("sanitizes raw/truncated LaTeX in checklists and prevents 6-subject background overload", () => {
		const formatted = formatPlainMathPreview(
			"Gặp $0\\cdot\\infty$ với dãy truy hồi, đổi nghịch đảo $\\frac{1}{x_{n+1}}-\\f",
			140,
		);
		assert.ok(!formatted.includes("$"));
		assert.ok(!formatted.endsWith("\\f"));
		assert.ok(formatted.includes("0·∞"));

		const config: PlannerConfig = {
			...DEFAULT_PLANNER_CONFIG,
			intensity: "balanced",
			dailyMaxSubjects: 2,
			mutedSubjects: ["Lập trình xử lý dữ liệu"],
			milestones: [
				{
					id: "ms_gt",
					kind: "competition",
					title: "Olympic Giải tích",
					subject: "Giải tích",
					dueDate: "2026-12-05",
					priority: 3,
					cognitiveLoad: "heavy",
					clusterIds: ["c_gt"],
					estimatedHours: 25,
					completedHours: 2,
					syllabusTopics: [],
					notes: "",
				},
				{
					id: "ms_ds",
					kind: "competition",
					title: "Olympic Đại số",
					subject: "Đại số",
					dueDate: "2026-12-10",
					priority: 2,
					cognitiveLoad: "heavy",
					clusterIds: ["c_ds"],
					estimatedHours: 18,
					completedHours: 0,
					syllabusTopics: [],
					notes: "",
				},
			],
		};
		const signals: PlannerPersonalSignals = {
			...sampleSignals("2026-11-16"),
			subjectSignals: [
				{
					clusterId: "c_gt",
					label: "Giải tích",
					nodeCount: 20,
					trackedCount: 10,
					dueCount: 2,
					weakCount: 1,
					untrackedCount: 8,
					readinessPct: 50,
					dueSampleNames: [],
					weakSampleNames: [],
					recentChatTitles: [],
					lastStudiedAt: null,
				},
				{
					clusterId: "c_ds",
					label: "Đại số",
					nodeCount: 15,
					trackedCount: 8,
					dueCount: 1,
					weakCount: 0,
					untrackedCount: 7,
					readinessPct: 60,
					dueSampleNames: [],
					weakSampleNames: [],
					recentChatTitles: [],
					lastStudiedAt: null,
				},
				{
					clusterId: "c_ltxl",
					label: "Lập trình xử lý dữ liệu",
					nodeCount: 12,
					trackedCount: 2,
					dueCount: 0,
					weakCount: 0,
					untrackedCount: 10,
					readinessPct: 25,
					dueSampleNames: [],
					weakSampleNames: [],
					recentChatTitles: [],
					lastStudiedAt: null,
				},
				{
					clusterId: "c_xstk",
					label: "XSTK",
					nodeCount: 10,
					trackedCount: 2,
					dueCount: 0,
					weakCount: 0,
					untrackedCount: 8,
					readinessPct: 30,
					dueSampleNames: [],
					weakSampleNames: [],
					recentChatTitles: [],
					lastStudiedAt: null,
				},
			],
			mistakeHints: {
				totalCount: 1,
				recurringPattern: "careless",
				recentRules: ["Gặp $0\\cdot\\infty$ với dãy truy hồi, tính $\\frac{1}{x_{n+1}}-\\f"],
			},
		};

		const plan = computeLocalPlannerPlan(config, signals, new Date("2026-11-16T08:00:00Z").getTime());
		assert.ok(plan.quotas.length <= 2);
		assert.ok(!plan.quotas.some((q) => q.subject.includes("Lập trình xử lý dữ liệu")));
		assert.ok(!plan.quotas.some((q) => q.subject === "XSTK"));
		assert.ok(plan.plannedStudyHours <= 5.5);
		assert.ok(plan.weeklyForecast?.every((d) => Array.isArray(d.subjects) && d.subjects.length >= 1));
		for (const q of plan.quotas) {
			for (const c of q.checklist) {
				assert.ok(!c.text.endsWith("\\f"));
				const dollarCount = (c.text.match(/\$/g) ?? []).length;
				assert.equal(dollarCount % 2, 0);
			}
		}

		// Solo focus day override emphasizes Đại số on demand
		const focused = computeLocalPlannerPlan(
			{
				...config,
				dayOverrides: {
					"2026-11-16": {
						date: "2026-11-16",
						focusSubjects: ["Đại số"],
						wakeTime: "08:30",
					},
				},
			},
			signals,
			new Date("2026-11-16T08:00:00Z").getTime(),
		);
		assert.equal(focused.todayWakeTime, "08:30");
		assert.equal(focused.quotas[0]?.subject, "Đại số");

		// Custom block timeline override is honored authoritatively
		const customized = computeLocalPlannerPlan(
			{
				...config,
				dayOverrides: {
					"2026-11-16": {
						date: "2026-11-16",
						customBlocks: [
							{
								id: "blk_c1",
								date: "2026-11-16",
								startTime: "09:00",
								endTime: "10:30",
								startMin: 540,
								endMin: 630,
								durationMin: 90,
								type: "study",
								title: "Giải đề Olympic Giải tích",
								subject: "Giải tích",
							},
						],
					},
				},
			},
			signals,
			new Date("2026-11-16T08:00:00Z").getTime(),
		);
		assert.equal(customized.isCustomEdited, true);
		assert.equal(customized.blocks.length, 1);
		assert.equal(customized.plannedStudyHours, 1.5);
	});

	it("calibrates personalized workload from measured FSRS + Practice speed and honors sufficiency gating", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-learn-profile-"));
		const plannerFile = path.join(dir, "planner.json");
		const flashcardsFile = path.join(dir, "flashcards.json");
		const chatsDir = path.join(dir, "chats");
		fs.mkdirSync(chatsDir, { recursive: true });

		// Fewer than 8 FSRS reviews -> baseline confidence only
		fs.writeFileSync(flashcardsFile, JSON.stringify({ reviews: [{ propositionId: "n1", rating: 3, at: 1 }], propositions: {} }));
		const baseline = await estimateMilestoneWorkloadServer({
			plannerFile,
			flashcardsFile,
			chatsDir,
			title: "Olympic Giải tích",
			subject: "Giải tích",
			baseHours: 20,
			dueDate: "2026-12-05",
		});
		assert.equal(baseline.confidence, "baseline");
		assert.equal(baseline.paceFactorApplied, 1);

		// Add 10 FSRS reviews (several lapses) + 2 Practice chats with slow problem timing + 2 logged days
		const reviews = Array.from({ length: 10 }, (_, i) => ({
			propositionId: "n1",
			rating: i % 3 === 0 ? 1 : 3,
			at: 1_700_000_000_000 + i * 1000,
		}));
		fs.writeFileSync(
			flashcardsFile,
			JSON.stringify({
				reviews,
				propositions: { n1: { schedule: { state: 2, reps: 10, lapses: 4, difficulty: 7.4, stability: 4.5 } } },
			}),
		);
		for (let idx = 1; idx <= 2; idx++) {
			fs.writeFileSync(
				path.join(chatsDir, `c_${idx}.json`),
				JSON.stringify({
					id: `c_${idx}`,
					title: "Luyện tập Giải tích",
					kind: "practice",
					createdAt: "2026-11-10T08:00:00Z",
					updatedAt: "2026-11-10T09:30:00Z",
					messages: [
						{ role: "assistant", timestamp: 1000, content: [{ type: "toolCall", id: "p1", name: "problem", arguments: {} }] },
						{
							role: "assistant",
							timestamp: 1000 + 35 * 60_000,
							content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "solvedWithHints" } }],
						},
					],
				}),
			);
		}
		patchPlannerConfig(
			{
				milestones: [
					{
						id: "m_gt",
						kind: "competition",
						title: "Olympic Giải tích",
						subject: "Giải tích",
						dueDate: "2026-12-05",
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
			{ plannerFile, flashcardsFile, chatsDir },
		);
		const signalsRich = buildPlannerPersonalSignals(sanitizePlannerConfig({}), { plannerFile, flashcardsFile, chatsDir, date: "2026-11-16" });
		assert.equal(signalsRich.learningProfile?.sufficientData, true);
		assert.equal(signalsRich.learningProfile?.overallSolveRatePct, 0);
		assert.equal(signalsRich.learningProfile?.avgMinutesPerProblem, 35);

		const personalized = computePersonalizedMilestoneEstimate({
			title: "Olympic Giải tích",
			subject: "Giải tích",
			kind: "competition",
			baseHours: 20,
			dueDate: "2026-12-05",
			todayDate: "2026-11-16",
			signals: signalsRich,
		});
		assert.equal(personalized.confidence, "personalized");
		assert.ok(personalized.estimatedHours > 20);
	});

	it("parses 24h journals, runs Plan-vs-Actual audits (local & AI), retains 100+ days, and streams research traces", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-journal-"));
		const plannerFile = path.join(dir, "planner.json");

		// Verify 365-day log retention (beyond previous 60-day cap)
		const manyLogs: Record<string, unknown> = {};
		for (let i = 0; i < 95; i++) {
			const dt = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
			manyLogs[dt] = { date: dt, completedBlockIds: [], completedChecklistIds: [], loggedStudyMinBySubject: { "Giải tích": 60 }, hobbyDone: false, mealsOk: true };
		}
		const sanitized = sanitizePlannerConfig({ logs: manyLogs });
		assert.equal(Object.keys(sanitized.logs).length, 95);

		const parsed = parseJournalTextLocal(
			"08:30-10:30 Giải bài tập Giải tích Olympic\n14:00-15:00 Lướt tiktok mệt\n20:00-21:00 Chạy bộ thể thao",
			"2026-11-16",
			["Giải tích"],
		);
		assert.equal(parsed.length, 3);
		assert.equal(parsed[0]?.category, "study");
		assert.equal(parsed[0]?.subject, "Giải tích");
		assert.equal(parsed[1]?.category, "distraction");
		assert.equal(parsed[2]?.category, "hobby");

		patchPlannerConfig(
			{
				milestones: [
					{
						id: "m1",
						kind: "competition",
						title: "Olympic Giải tích",
						subject: "Giải tích",
						dueDate: "2026-11-26",
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
			{ plannerFile },
		);

		const localAudit = await evaluateDailyJournalServer({
			plannerFile,
			date: "2026-11-16",
			journalText: "09:00-11:00 Giải bài Giải tích\n15:00-16:30 Lướt youtube sao nhãng",
			mode: "local",
		});
		assert.equal(localAudit.report.evaluatedBy, "local");
		assert.ok(localAudit.report.actualStudyMin >= 120);
		assert.ok(localAudit.snapshot.config.logs["2026-11-16"]?.compliance?.adherencePct !== undefined);

		const aiEvalEngine = fakeSubmitEngine("submit_journal_evaluation", {
			adherencePct: 82,
			actualStudyMin: 180,
			summary: "Completed solid proof session with minor afternoon phone drift.",
			strengths: ["Morning Olympiad problems"],
			frictionPoints: ["1h afternoon YouTube scroll"],
			nextDayAdvice: "Move heavy proofs to 08:30 sharp.",
			entries: [
				{ startTime: "08:30", endTime: "11:30", category: "study", subject: "Giải tích", title: "Proof set", minutes: 180 },
			],
		});
		const llmAudit = await evaluateDailyJournalServer({
			plannerFile,
			date: "2026-11-16",
			journalText: "08:30-11:30 Học Giải tích",
			mode: "llm",
			engineOverride: aiEvalEngine,
		});
		assert.equal(llmAudit.report.evaluatedBy, "llm");
		assert.equal(llmAudit.report.adherencePct, 82);

		// Research trace callback records linked_context, synthesizing, and done phases
		const steps: string[] = [];
		const researchEngine = fakeSubmitEngine("submit_exam_syllabus", {
			subject: "Giải tích",
			cognitiveLoad: "heavy",
			priority: 3,
			estimatedHours: 24,
			syllabusTopics: [{ title: "Dãy số & Giới hạn", estHours: 8 }, { title: "Tích phân suy rộng", estHours: 16 }],
			sourceSummary: "Verified via custom faux engine.",
		});
		const researched = await researchExamSyllabus({
			title: "Olympic Toán Giải tích Sinh viên",
			engineOverride: researchEngine,
			onStep: (s) => steps.push(s.phase),
		});
		assert.ok(steps.includes("linked_context"));
		assert.ok(steps.includes("synthesizing"));
		assert.ok(steps.includes("done"));
		assert.equal(researched.modelLabel, "custom");
		assert.ok(researched.trace.length >= 3);
	});

	it("guarantees Healthy < Balanced < Intensive across Local and AI Coach + syncs 7-day forecast, early-waking nap, gaming cutoff, and concrete session context", async () => {
		const heavySignals: PlannerPersonalSignals = {
			...sampleSignals("2026-11-16"),
			subjectSignals: [
				{
					clusterId: "c_calc",
					label: "Olympic Giải tích",
					nodeCount: 20,
					trackedCount: 8,
					dueCount: 2,
					weakCount: 1,
					untrackedCount: 10,
					readinessPct: 40,
					dueSampleNames: ["Định lý Stolz-Cesàro"],
					weakSampleNames: ["Giới hạn dãy số"],
					untrackedSampleNames: ["Tích phân suy rộng loại 2"],
					attachedFiles: ["De_Olympic_SV_2025.pdf"],
					activePlanTopics: ["Chương 2: Giới hạn hàm & Đạo hàm"],
					pendingProblems: ["Đề 1 BTVN câu 8: Tìm lim x_n"],
					recentChatTitles: ["Dạy giải tích olympic sinh viên"],
					lastStudiedAt: "2026-11-15T10:00:00Z",
				},
			],
		};

		const heavyExamConfig: PlannerConfig = {
			...DEFAULT_PLANNER_CONFIG,
			lifestyle: {
				...DEFAULT_PLANNER_CONFIG.lifestyle,
				gameBudgetMin: 40,
				gameCutoffBeforeBedMin: 90,
				sleep: {
					...DEFAULT_PLANNER_CONFIG.lifestyle.sleep,
					targetBedtime: "23:15",
					preferredWakeTime: "07:00",
					earlyWakingIssue: true,
					windDownBufferMin: 40,
					allowMiddayRecoveryNap: true,
				},
				wellnessGuardrail: {
					enabled: true,
					currentWeeklyFreq: 5,
					targetWeeklyFreq: 2,
					riskWindows: ["late_night", "post_stress"],
					replacementProtocol: "10m outdoor walk + offline book",
				},
			},
			milestones: [
				{
					id: "ms_big1",
					kind: "competition",
					title: "Olympic Giải tích",
					subject: "Olympic Giải tích",
					dueDate: "2026-11-26",
					priority: 3,
					cognitiveLoad: "heavy",
					clusterIds: ["c_calc"],
					estimatedHours: 70,
					completedHours: 0,
					syllabusTopics: [],
					notes: "",
				},
			],
		};

		const healthy = computeLocalPlannerPlan({ ...heavyExamConfig, intensity: "healthy" }, heavySignals, new Date("2026-11-16T08:00:00Z").getTime());
		const balanced = computeLocalPlannerPlan({ ...heavyExamConfig, intensity: "balanced" }, heavySignals, new Date("2026-11-16T08:00:00Z").getTime());
		const intensive = computeLocalPlannerPlan({ ...heavyExamConfig, intensity: "intensive" }, heavySignals, new Date("2026-11-16T08:00:00Z").getTime());

		assert.ok(healthy.minDailyStudyHours <= 4.0);
		assert.ok(healthy.examDeficitWarning?.includes("Healthy cap"));
		assert.ok(healthy.plannedStudyHours < balanced.plannedStudyHours);
		assert.ok(balanced.plannedStudyHours <= intensive.plannedStudyHours);
		assert.ok(healthy.blocks.some((b) => b.id.startsWith("blk_nap_")));
		const gameBlk = healthy.blocks.find((b) => b.id.startsWith("blk_game_"));
		assert.ok(gameBlk);
		assert.ok(gameBlk.endMin <= (healthy.blocks.find((b) => b.type === "sleep")?.startMin ?? 9999));

		// Check concrete session work items surfaced in checklists + AI digest
		const qText = healthy.quotas.flatMap((q) => q.checklist.map((c) => c.text)).join(" | ");
		assert.ok(qText.includes("Đề 1 BTVN câu 8"));
		assert.ok(qText.includes("Chương 2: Giới hạn hàm"));

		// Verify clipPreservingLatex keeps balanced $...$ math without cutting inside \frac
		const safeMath = clipPreservingLatex("Gặp $0\\cdot\\infty$ với dãy truy hồi, tính $\\frac{1}{x_{n+1}}-\\frac{1}{x_n}$ cuối kỳ", 80);
		assert.equal((safeMath.match(/\$/g) ?? []).length % 2, 0);

		// Verify applyLlmPlanOutput enforces Healthy cap AND syncs 7-day forecast
		const aiMergedHealthy = applyLlmPlanOutput(
			healthy,
			{
				coachSummary: "Keep balanced.",
				minDailyStudyHours: 6.5, // Hallucinated too high for Healthy
				blocks: [
					{ startTime: "08:15", endTime: "10:15", type: "study", subject: "Olympic Giải tích", title: "De_Olympic_SV_2025.pdf — Đề 1 BTVN câu 8" },
					{ startTime: "10:30", endTime: "12:00", type: "study", subject: "Olympic Giải tích", title: "Chương 2" },
					{ startTime: "14:00", endTime: "16:30", type: "study", subject: "Olympic Giải tích", title: "Overflow block" },
					{ startTime: "16:45", endTime: "19:15", type: "study", subject: "Olympic Giải tích", title: "Second overflow block" },
				],
				quotas: [{ subject: "Olympic Giải tích", targetMin: 420, checklist: ["Giải Đề 1 BTVN câu 8"] }],
			},
			{ ...heavyExamConfig, intensity: "healthy" },
			"test-model",
		);
		assert.ok(aiMergedHealthy.plannedStudyHours <= 4.1);
		assert.ok(aiMergedHealthy.minDailyStudyHours <= 4.1);
		assert.equal(aiMergedHealthy.weeklyForecast?.[0]?.plannedHours, aiMergedHealthy.plannedStudyHours);

		// Notion CSV parser skips completed "Yes" rows and imports unfinished tasks
		const notionParsed = parseLocalSyllabusOutline(
			"Bài,Hoàn Thành,Note,Trạng thái,Độ khó\n10.20,Yes,,✓,🟢\n10.21,No,,△,🔴\n11.17,No,,○,🟠",
		);
		assert.equal(notionParsed.syllabusTopics.length, 2);
		assert.ok(notionParsed.syllabusTopics[0]?.title.includes("10.21"));

		// Lifestyle optimizer works in both 0-token local and BYOK AI modes
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-life-"));
		const plannerFile = path.join(dir, "planner.json");
		patchPlannerConfig({ lifestyle: heavyExamConfig.lifestyle }, { plannerFile });
		const localOpt = await suggestLifestyleBalanceServer({ plannerFile, useAi: false });
		assert.equal(localOpt.modelLabel, "local:lifestyle-optimizer");
		assert.ok(localOpt.windDownBufferMin >= 40);
		const aiOpt = await suggestLifestyleBalanceServer({
			plannerFile,
			useAi: true,
			engineOverride: fakeSubmitEngine("submit_lifestyle_balance", {
				hobbies: ["Afternoon Walk", "Music"],
				dailyHobbyMin: 75,
				gameBudgetMin: 30,
				gameCutoffBeforeBedMin: 120,
				windDownBufferMin: 45,
				allowMiddayRecoveryNap: true,
				rationale: "Prioritize deep sleep pressure & screen curfew.",
				tips: ["Stop games 2h before bed"],
			}),
		});
		assert.equal(aiOpt.gameCutoffBeforeBedMin, 120);
	});

	it("computes scientific 6-axis Learning Capacity diagnostics & powers conversational Coach Side Chat with Undo", async () => {
		const report = computeLearningCapacityReport({
			config: {
				...DEFAULT_PLANNER_CONFIG,
				realismFactor: 0.9,
				logs: {
					"2026-11-15": {
						date: "2026-11-15",
						actualBedtime: "23:30",
						actualWakeTime: "04:45",
						wokeEarlyUnintended: true,
						energyScore: 2,
						completedBlockIds: [],
						completedChecklistIds: [],
						loggedStudyMinBySubject: { "Olympic Giải tích": 180 },
						hobbyDone: true,
						mealsOk: true,
						compliance: {
							date: "2026-11-15",
							evaluatedAt: "2026-11-15T22:00:00Z",
							evaluatedBy: "local",
							adherencePct: 76,
							plannedStudyMin: 240,
							actualStudyMin: 180,
							realismRatio: 0.75,
							summary: "76%",
							strengths: [],
							frictionPoints: [],
							nextDayAdvice: "Pace down morning",
						},
					},
				},
			},
			signals: {
				...sampleSignals("2026-11-16"),
				learningProfile: {
					sufficientData: true,
					sufficiencyReason: "Calibrated",
					totalFsrsReviews: 24,
					totalPracticeSessions: 4,
					totalTeachSessions: 2,
					loggedStudyDays: 2,
					overallRetentionPct: 83,
					overallSolveRatePct: 67,
					avgMinutesPerProblem: 22,
					avgMinutesPerTopic: 45,
					sustainableDailyHours: 4.5,
					realismFactor: 0.9,
					bySubject: {
						"Olympic Giải tích": {
							subject: "Olympic Giải tích",
							fsrsReviews: 24,
							fsrsTrackedNodes: 6,
							retentionRatePct: 83,
							lapseRatePct: 12,
							avgDifficulty: 6.1,
							avgStabilityDays: 11.4,
							practiceSessions: 4,
							practiceSolvedCount: 4,
							practiceHintsCount: 1,
							practiceUnsolvedCount: 1,
							practiceSolveRatePct: 67,
							avgMinutesPerProblem: 22,
							avgMinutesPerSession: 48,
							teachSessions: 2,
							loggedPlannerMinutes: 180,
							paceFactor: 1.12,
						},
					},
				},
			},
			fsrsWeights: new Array<number>(21).fill(0.25),
			fsrsReviewRatings: [3, 4, 3, 1, 3, 4, 2, 3],
			graphNodeCount: 20,
			graphChainCount: 12,
			quizSamples: [
				{ subject: "Olympic Giải tích", sessionTitle: "Olympic Giải tích", confidencePct: 95, correct: false, dontKnow: false, origin: "quiz" },
				{ subject: "Olympic Giải tích", sessionTitle: "Olympic Giải tích", confidencePct: 90, correct: true, dontKnow: false, origin: "quiz" },
				{ subject: "Olympic Giải tích", sessionTitle: "Olympic Giải tích", confidencePct: 85, correct: false, dontKnow: false, origin: "quiz" },
			],
			practiceSamples: [
				{ subject: "Olympic Giải tích", sessionTitle: "Olympic Giải tích", outcome: "solved", rung: null, missClass: null, durationMin: 20 },
				{ subject: "Olympic Giải tích", sessionTitle: "Olympic Giải tích", outcome: "solvedWithHints", rung: "R1", missClass: "careless", durationMin: 24 },
			],
			mistakes: [
				{
					id: "c1:tc1",
					chatId: "c1",
					kind: "missed",
					origin: "quiz",
					question: "Limit question",
					yourAnswer: "A",
					correctAnswer: "B",
					answeredAt: "2026-11-15T10:00:00Z",
					sessionTitle: "Olympic Giải tích",
					sessionKind: "teach",
					sources: [],
					createdAt: "2026-11-15T10:00:00Z",
					status: "ready",
					analysis: {
						errorType: "calculation-slip",
						topic: "Recurrence",
						whatYouDid: "Wrong sign",
						correct: "Invert sequence",
						rule: "Dùng nghịch đảo $\\frac{1}{x_n}$",
					},
				},
			],
			now: new Date("2026-11-16T08:00:00Z").getTime(),
		});

		assert.equal(report.dimensions.length, 6);
		assert.ok(report.compositeScore !== null && report.compositeScore > 0);
		assert.equal(report.dataCoverage.hasCustomFsrsWeights, true);
		assert.equal(report.metacognition.biasDirection, "overconfident");
		assert.ok((report.metacognition.brierScore ?? 0) > 0.3);
		assert.equal(report.errorProfile.slipRatePct, 100);
		assert.ok(report.subjectBreakdown.some((s) => s.subject === "Olympic Giải tích" && s.quizBiasPct !== null));

		// End-to-end isolated storage tests for Capacity + Coach Side Chat + Undo
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coach-"));
		const plannerFile = path.join(dir, "planner.json");
		const chatsDir = path.join(dir, "chats");
		const flashcardsFile = path.join(dir, "flashcards.json");
		const mistakesFile = path.join(dir, "mistakes.json");
		fs.mkdirSync(chatsDir, { recursive: true });
		fs.writeFileSync(
			path.join(chatsDir, "c1.json"),
			JSON.stringify({
				id: "c1",
				title: "Dạy Olympic Giải tích",
				kind: "practice",
				createdAt: "2026-11-15T09:00:00Z",
				updatedAt: "2026-11-15T11:00:00Z",
				messages: [
					{ role: "assistant", content: [{ type: "toolCall", id: "p1", name: "problem", arguments: {} }], timestamp: 1000 },
					{
						role: "toolResult",
						toolCallId: "q1",
						toolName: "quiz",
						details: { kind: "quiz", questionText: "Cauchy?", dontKnow: false, answers: [{ label: "A" }], correct: true, confidence: 85, answeredAt: "2026-11-15T09:10:00Z" },
						isError: false,
						timestamp: 601_000,
					},
					{
						role: "toolResult",
						toolCallId: "p1",
						toolName: "conclude",
						details: { outcome: "solved", rung: null, missClass: null },
						isError: false,
						timestamp: 960_000,
					},
				],
			}),
		);
		fs.writeFileSync(
			flashcardsFile,
			JSON.stringify({
				settings: { weights: new Array<number>(21).fill(0.22) },
				reviews: [{ rating: 3 }, { rating: 4 }, { rating: 3 }, { rating: 3 }],
				propositions: {},
			}),
		);
		fs.writeFileSync(mistakesFile, "[]");
		patchPlannerConfig(
			{
				milestones: [
					{
						id: "m_olp",
						kind: "competition",
						title: "Olympic Giải tích",
						subject: "Olympic Giải tích",
						dueDate: "2026-11-26",
						priority: 3,
						cognitiveLoad: "heavy",
						clusterIds: [],
						estimatedHours: 25,
						completedHours: 0,
						syllabusTopics: [],
						notes: "",
					},
				],
			},
			{ plannerFile },
		);

		const capRead = readPlannerLearningCapacityServer({ plannerFile, chatsDir, flashcardsFile, mistakesFile, date: "2026-11-16" });
		assert.equal(capRead.report.dataCoverage.quizConfidenceSamples, 1);
		assert.equal(capRead.report.dataCoverage.practiceProblems, 1);
		assert.equal(capRead.report.dataCoverage.hasCustomFsrsWeights, true);

		const diagRes = await diagnoseLearningCapacityWithAiServer({
			plannerFile,
			chatsDir,
			flashcardsFile,
			mistakesFile,
			date: "2026-11-16",
			engineOverride: fakeSubmitEngine("submit_capacity_diagnosis", {
				summary: "Strong problem speed with balanced calibration.",
				strengths: ["Solved problem cleanly in 16m"],
				bottlenecks: ["Need more FSRS reviews"],
				neuroProtocols: ["Keep 50m deep focus blocks", "Add spaced recall after problems"],
				suggestedPaceNote: "1.0x pace fits cleanly.",
			}),
		});
		assert.equal(diagRes.diagnosis.neuroProtocols.length, 2);

		const calibrated = calibratePlannerFromCapacityServer({ plannerFile, chatsDir, flashcardsFile, mistakesFile, date: "2026-11-16" });
		assert.ok(calibrated.snapshot.config.realismFactor !== undefined);

		// Turn 1: Ask coach side chat to soften today & set early wake + focus subject
		const turn1 = await chatWithPlannerCoachServer({
			plannerFile,
			chatsDir,
			flashcardsFile,
			mistakesFile,
			date: "2026-11-16",
			focusArea: "schedule",
			message: "Hôm nay anh dậy 4h sáng hơi mệt, tập trung Olympic Giải tích và tối ngủ 22:30",
			engineOverride: fakeSubmitEngine("submit_coach_response", {
				reply: "Đã cập nhật wake 04:00, ngủ 22:30 và thêm giấc ngủ trưa ngắn phục hồi cho bạn.",
				shouldApplyChanges: true,
				changesSummary: "Wake 04:00 · Sleep 22:30 · Focus Olympic Giải tích",
				regenerateTodaySchedule: true,
				todayLogPatch: { energyScore: 2, actualWakeTime: "04:00", wokeEarlyUnintended: true },
				todayOverridePatch: { wakeTime: "04:00", sleepTime: "22:30", focusSubjects: ["Olympic Giải tích"] },
			}),
		});
		assert.equal(turn1.snapshot.config.dayOverrides?.["2026-11-16"]?.wakeTime, "04:00");
		assert.equal(turn1.snapshot.config.dayOverrides?.["2026-11-16"]?.bedTime, "22:30");
		assert.equal(turn1.snapshot.config.logs["2026-11-16"]?.wokeEarlyUnintended, true);
		assert.equal(turn1.snapshot.config.coachChat?.length, 2);

		// Turn 2: Ask coach to change lifestyle hobbies & game budget, then Undo Turn 2!
		const turn2 = await chatWithPlannerCoachServer({
			plannerFile,
			chatsDir,
			flashcardsFile,
			mistakesFile,
			date: "2026-11-16",
			focusArea: "lifestyle",
			message: "Chỉnh Hobby 75p và Game 30p cutoff 120p",
			engineOverride: fakeSubmitEngine("submit_coach_response", {
				reply: "Đã tăng hobby lên 75 phút và đặt giới hạn game 30 phút trước ngủ 120 phút.",
				shouldApplyChanges: true,
				changesSummary: "Hobby 75m · Game 30m before 120m",
				regenerateTodaySchedule: true,
				lifestylePatch: { dailyHobbyMin: 75, gameBudgetMin: 30, gameCutoffBeforeBedMin: 120 },
			}),
		});
		assert.equal(turn2.snapshot.config.lifestyle.dailyHobbyMin, 75);
		assert.equal(turn2.snapshot.config.lifestyle.gameBudgetMin, 30);

		const undone = undoPlannerCoachChangeServer({
			plannerFile,
			chatsDir,
			flashcardsFile,
			mistakesFile,
			date: "2026-11-16",
			messageId: turn2.assistantMessage.id,
		});
		assert.equal(undone.undone, true);
		assert.equal(undone.snapshot.config.lifestyle.dailyHobbyMin, DEFAULT_PLANNER_CONFIG.lifestyle.dailyHobbyMin);
		assert.equal(undone.snapshot.config.coachChat?.find((m) => m.id === turn2.assistantMessage.id)?.appliedChange?.reverted, true);

		const cleared = clearPlannerCoachChatServer({ plannerFile, chatsDir, flashcardsFile, mistakesFile, date: "2026-11-16" });
		assert.equal(cleared.config.coachChat?.length ?? 0, 0);
	});
});

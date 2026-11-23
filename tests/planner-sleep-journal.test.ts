import assert from "node:assert/strict";
import { it } from "node:test";
import {
	DEFAULT_PLANNER_CONFIG,
	applyHabitCheckIn,
	buildFromPlanJournalLines,
	buildJournalAutoDraft,
	computeSleepAnchorForDate,
	formatJournalDraftLines,
	journalBedtimeForNight,
	journalClockPoints,
	journalWakeForDate,
	parseJournalTextLocal,
	redactSensitiveJournalText,
	sanitizeFormattedJournalText,
	sanitizePlannerConfig,
	type DailyHabitLog,
} from "../src/core/planner.ts";

const log = (date: string, journalText: string): DailyHabitLog => ({ date, journalText, completedBlockIds: [], completedChecklistIds: [], loggedStudyMinBySubject: {}, hobbyDone: false, mealsOk: false });

it("uses the selected night for bedtime and the next morning for wake, including after midnight", () => {
	const logs = { "2026-11-16": log("2026-11-16", "23:45: Ngủ"), "2026-11-17": log("2026-11-17", "07:40: Thức dậy") };
	assert.deepEqual(journalBedtimeForNight(logs, "2026-11-16"), { time: "23:45", source: "journal" });
	assert.deepEqual(journalWakeForDate(logs, "2026-11-17"), { time: "07:40", source: "journal" });
	assert.equal(computeSleepAnchorForDate(DEFAULT_PLANNER_CONFIG.lifestyle.sleep, logs, "2026-11-17", "balanced").actualLastSleepHours, 7.9);
	const afterMidnight = { "2026-11-17": log("2026-11-17", "00:30: Ngủ\n07:40: Thức dậy") };
	assert.equal(journalBedtimeForNight(afterMidnight, "2026-11-16")?.time, "00:30");
	assert.equal(computeSleepAnchorForDate(DEFAULT_PLANNER_CONFIG.lifestyle.sleep, afterMidnight, "2026-11-17", "balanced").actualLastSleepHours, 7.2);
	const ambiguous = { "2026-11-16": log("2026-11-16", "23:45: Ngủ\n23:50: Ngủ") };
	assert.equal(journalBedtimeForNight(ambiguous, "2026-11-16"), null);
	assert.equal(journalBedtimeForNight({ "2026-11-16": { ...ambiguous["2026-11-16"], actualBedtime: "23:30" } }, "2026-11-16")?.time, "23:30", "check-in takes precedence over journal inference");
});

it("allows removing a mistaken sleep check-in without erasing the journal", () => {
	const first = applyHabitCheckIn(DEFAULT_PLANNER_CONFIG, { date: "2026-11-17", actualBedtime: "23:45", actualWakeTime: "07:40", journalText: "A private journal entry." });
	const updated = applyHabitCheckIn(first, { date: "2026-11-17", actualBedtime: null });
	assert.equal(updated.logs["2026-11-17"]?.actualBedtime, undefined);
	assert.equal(updated.logs["2026-11-17"]?.actualWakeTime, "07:40");
	assert.equal(updated.logs["2026-11-17"]?.journalText, "A private journal entry.");
});

it("recognizes Vietnamese half hours and only masks the sensitive phrase", () => {
	assert.deepEqual([...journalClockPoints("7h40; 8r; 10h; 10:40")], ["07:40", "08:30", "10:00", "10:40"]);
	assert.deepEqual([...journalClockPoints("Làm được 10 rồi nghỉ, học từ 8r đến 10h")], ["08:30", "10:00"]);
	assert.equal(redactSensitiveJournalText("📚 Break and masturbation, then continue reading."), "📚 Break and [private], then continue reading.");
	const masked18 = redactSensitiveJournalText("Tối xem phim 18+ rồi đi ngủ");
	assert.ok(masked18.includes("[private]"));
	assert.equal(/18\+/.test(masked18), false);
	assert.equal(redactSensitiveJournalText("Học bài 18 rồi nghỉ"), "Học bài 18 rồi nghỉ");
});

it("avoids false Vietnamese wake/bedtime matches for teaching, sequences, and midday naps while keeping half-hour sleep markers", () => {
	const falseWakeLogs = {
		"2026-11-17": log("2026-11-17", "08:00: Dạy giải tích olympic sinh viên\n14:00: Dãy số"),
	};
	assert.equal(journalWakeForDate(falseWakeLogs, "2026-11-17"), null);
	assert.equal(
		journalWakeForDate({ "2026-11-17": log("2026-11-17", "7r: Thức dậy\n08:00: Dạy giải tích olympic sinh viên") }, "2026-11-17")?.time,
		"07:30",
	);

	const napLogs = {
		"2026-11-16": log("2026-11-16", "13:00: Ngủ trưa\n23r: Đi ngủ"),
	};
	assert.equal(journalBedtimeForNight(napLogs, "2026-11-16")?.time, "23:30");
	assert.equal(journalBedtimeForNight({ "2026-11-16": log("2026-11-16", "13:00: Ngủ trưa") }, "2026-11-16"), null);
});

it("recognizes extended Vietnamese natural clock forms while ignoring gram and count suffixes", () => {
	assert.deepEqual(
		[...journalClockPoints("Dậy 8h rưỡi hoặc 8 giờ 30, xong 8 giờ rưỡi, ăn sáng 9 giờ, làm 8g30 và 10h 2 bài")].sort(),
		["08:30", "09:00", "10:00"],
	);
	assert.deepEqual([...journalClockPoints("Pha 10g đường vào cốc nước")], []);
});

it("sanitizes AI-formatted journals with strict clock grounding, discreet masking, and downstream parsing", () => {
	const raw =
		"hôm nay tôi dậy từ 8h, 9h ăn sáng, 10r ăn cơm, sau đó call người yêu 1 mạch từ 11r đến 13h30, rồi lại thủ dâm đến 14h25, rồi ngủ đến 15h30, dậy tắm rửa đến 16h30, sau đó 17h tôi học được 1 ca đến 17h45 môn biểu diễn tri thức";
	const aiFormatted = [
		"- 08:00 - 08:15 : Dậy",
		"09:00 : Ăn sáng",
		"10:30 : Ăn cơm",
		"11:30 - 13:30 : Call người yêu",
		"13:30 - 14:25 : Thủ dâm",
		"14:25 - 15:30 : Ngủ trưa",
		"15:30 - 16:30 : Dậy tắm rửa, tỉnh táo hơn",
		"17:00 - 17:45 : Học Biểu diễn tri thức",
	].join("\n");

	const discreetOut = sanitizeFormattedJournalText(aiFormatted, raw, { discreet: true });
	assert.ok(discreetOut);
	const lines = discreetOut.split("\n");
	assert.equal(lines[0], "08:00 : Dậy", "hallucinated 08:15 end time downgrades to single clock");
	assert.equal(lines[1], "09:00 : Ăn sáng");
	assert.equal(lines[3], "11:30 - 13:30 : Call người yêu");
	assert.equal(lines[4], "13:30 - 14:25 : [private]", "sensitive activity masked when discreet=true");
	assert.equal(lines[7], "17:00 - 17:45 : Học Biểu diễn tri thức");

	const rawOut = sanitizeFormattedJournalText(aiFormatted, raw, { discreet: false });
	assert.ok(rawOut?.includes("13:30 - 14:25 : Thủ dâm"), "discreet=false retains original text");

	assert.equal(journalWakeForDate({ "2026-11-23": log("2026-11-23", discreetOut) }, "2026-11-23")?.time, "08:00");
	const parsed = parseJournalTextLocal(discreetOut, "2026-11-23", ["Biểu diễn tri thức"]);
	const studyEntry = parsed.find((e) => e.category === "study");
	assert.equal(studyEntry?.startTime, "17:00");
	assert.equal(studyEntry?.endTime, "17:45");
	assert.equal(studyEntry?.subject, "Biểu diễn tri thức");

	assert.equal(
		sanitizeFormattedJournalText("08:00 : Dậy\n17:00 - 17:45 : Học", raw, { discreet: true }),
		null,
		"rejects severely truncated rewrites covering < 50% of raw clock points",
	);
	assert.equal(
		sanitizeFormattedJournalText("08:00 - 09:00 : Học bài", "Hôm nay hơi mệt nên chưa học được gì", { discreet: true }),
		null,
		"never invents clocks on purely untimed journals",
	);
});

it("builds Auto-Draft timeline from app sessions, FSRS bursts, checked blocks, fixed events, and PC presence without duplicating existing lines", () => {
	const date = "2026-11-23";
	const now = new Date(2026, 10, 23, 18, 0).getTime();
	const ts = (hh: number, mm: number) => new Date(2026, 10, 23, hh, mm).getTime();

	const draft = buildJournalAutoDraft({
		date,
		now,
		log: {
			...log(date, ""),
			actualWakeTime: "07:30",
			completedBlockIds: ["blk_session_dup", "blk_hobby"],
		},
		plan: {
			date,
			generatedAt: new Date(now).toISOString(),
			engineUsed: "local",
			intensity: "balanced",
			minDailyStudyHours: 2,
			plannedStudyHours: 2,
			freeHoursTotal: 6,
			recommendedBedtime: "23:15",
			recommendedWakeTime: "07:00",
			todayWakeTime: "07:30",
			sleepShiftAdvice: "",
			daysToSleepTarget: 0,
			quotas: [],
			blocks: [
				{
					id: "blk_session_dup",
					date,
					startTime: "09:00",
					endTime: "09:50",
					startMin: 540,
					endMin: 590,
					durationMin: 50,
					type: "study",
					subject: "Đại số",
					title: "Đại số theo lịch",
				},
				{
					id: "blk_hobby",
					date,
					startTime: "16:30",
					endTime: "17:15",
					startMin: 990,
					endMin: 1035,
					durationMin: 45,
					type: "hobby",
					title: "Chạy bộ",
				},
			],
		},
		fixedEvents: [
			{ id: "fe1", dayOfWeek: "mon", startTime: "13:30", endTime: "15:00", title: "Cơ sở toán AI", category: "class" },
			{ id: "fe_future", dayOfWeek: "mon", startTime: "19:00", endTime: "21:00", title: "Lớp tối chưa tới", category: "class" },
		],
		sessionActivity: [
			{ title: "Dạy đại số", subject: "Đại số", timestamps: [ts(9, 5), ts(9, 25), ts(9, 48)] },
		],
		fsrsReviewTimestamps: [ts(10, 5), ts(10, 8), ts(10, 12), ts(10, 18)],
		presence: {
			date,
			firstActiveAt: "08:00",
			lastActiveAt: "17:55",
			awayIntervals: [
				{ startTime: "12:00", endTime: "13:00", reason: "sleep" },
				{ startTime: "13:30", endTime: "15:00", reason: "idle" }, // overlaps fixed event >= 40% -> suppressed
			],
		},
	});

	assert.equal(draft[0]?.source, "wake");
	assert.equal(draft[0]?.startTime, "07:30");
	assert.ok(draft.some((d) => d.source === "session" && d.startTime === "09:05" && d.endTime === "09:48"));
	assert.ok(!draft.some((d) => d.source === "checked_block" && d.label === "Đại số theo lịch"), "checked block covered by session cluster is skipped");
	assert.ok(draft.some((d) => d.source === "fsrs" && d.startTime === "10:05" && d.endTime === "10:18"));
	assert.ok(draft.some((d) => d.source === "presence_away" && d.startTime === "12:00" && d.endTime === "13:00"));
	assert.ok(!draft.some((d) => d.source === "presence_away" && d.startTime === "13:30"), "away window overlapped by class is suppressed");
	assert.ok(draft.some((d) => d.source === "fixed_event" && d.label === "Cơ sở toán AI"));
	assert.ok(!draft.some((d) => d.label === "Lớp tối chưa tới"), "future fixed event not included");
	assert.ok(draft.some((d) => d.source === "checked_block" && d.label === "Chạy bộ"));

	const formatted = formatJournalDraftLines(draft, "07:30 : Thức dậy");
	assert.equal(formatted.split("\n").filter((l) => l.startsWith("07:30")).length, 1, "does not duplicate existing wake clock line");
	assert.ok(formatted.includes("09:05 - 09:48 : Học Đại số"));

	const copied = buildFromPlanJournalLines(
		{
			date,
			generatedAt: new Date(now).toISOString(),
			engineUsed: "local",
			intensity: "balanced",
			minDailyStudyHours: 1,
			plannedStudyHours: 1,
			freeHoursTotal: 6,
			recommendedBedtime: "23:15",
			recommendedWakeTime: "07:00",
			todayWakeTime: "07:30",
			sleepShiftAdvice: "",
			daysToSleepTarget: 0,
			quotas: [],
			blocks: [
				{ id: "s1", date, startTime: "08:00", endTime: "08:50", startMin: 480, endMin: 530, durationMin: 50, type: "study", title: "Giải tích" },
				{ id: "brk", date, startTime: "08:50", endTime: "09:00", startMin: 530, endMin: 540, durationMin: 10, type: "break", title: "Break" },
				{ id: "fut", date, startTime: "20:00", endTime: "20:50", startMin: 1200, endMin: 1250, durationMin: 50, type: "study", title: "Future" },
			],
		},
		now,
	);
	assert.equal(copied, "08:00 - 08:50 : Giải tích");
});

it("logs elapsed duration and study minutes when switching or stopping live Quick Switcher activity", () => {
	const t1 = new Date(2026, 10, 23, 14, 0).getTime();
	const t2 = new Date(2026, 10, 23, 14, 45).getTime();
	const t3 = new Date(2026, 10, 23, 15, 20).getTime();

	const started = applyHabitCheckIn(
		DEFAULT_PLANNER_CONFIG,
		{ date: "2026-11-23", switchActivity: { label: "Đại số", category: "study", subject: "Đại số" } },
		t1,
	);
	assert.deepEqual(started.logs["2026-11-23"]?.activeActivity, {
		label: "Đại số",
		category: "study",
		subject: "Đại số",
		startedAt: "14:00",
	});

	const switched = applyHabitCheckIn(
		started,
		{ date: "2026-11-23", switchActivity: { label: "Ngủ trưa", category: "sleep" } },
		t2,
	);
	assert.equal(switched.logs["2026-11-23"]?.journalText, "14:00 - 14:45 : Đại số");
	assert.equal(switched.logs["2026-11-23"]?.loggedStudyMinBySubject["Đại số"], 45);
	assert.equal(switched.logs["2026-11-23"]?.activeActivity?.label, "Ngủ trưa");

	const stopped = applyHabitCheckIn(switched, { date: "2026-11-23", switchActivity: null }, t3);
	assert.equal(stopped.logs["2026-11-23"]?.journalText, "14:00 - 14:45 : Đại số\n14:45 - 15:20 : Ngủ trưa");
	assert.equal(stopped.logs["2026-11-23"]?.activeActivity, undefined);

	// Survives full config sanitization round-trip while active
	const roundTripped = sanitizePlannerConfig(JSON.parse(JSON.stringify(switched)));
	assert.deepEqual(roundTripped.logs["2026-11-23"]?.activeActivity, switched.logs["2026-11-23"]?.activeActivity);
});

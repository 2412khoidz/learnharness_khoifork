import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_PLANNER_CONFIG, applyHabitCheckIn, computeSleepAnchorForDate, journalBedtimeForNight, journalClockPoints, journalWakeForDate, redactSensitiveJournalText, type DailyHabitLog } from "../src/core/planner.ts";

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
	assert.equal(redactSensitiveJournalText("📚 Break and masturbation, then continue reading."), "📚 Break and [private], then continue reading.");
});

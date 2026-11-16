import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { chatWithPlannerCoachServer, checkInPlannerHabit, patchPlannerConfig, readPlannerSnapshot, undoPlannerCoachChangeServer } from "../src/server/planner.ts";
import { readExamPrepConfig, writeExamPrepConfig } from "../src/server/exam-prep.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coach-permissions-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const now = new Date(2026, 10, 16, 15, 51).getTime();
const date = "2026-11-16";
function engine(args: unknown, capture: (s: string) => void = () => {}): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", args as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	return { model: faux.getModel(), streamFn: (model, context, options) => { capture(JSON.stringify(context)); return faux.streamSimple(model, context, options); } };
}
function fixture(name: string) {
	const plannerFile = path.join(dir, `${name}-planner.json`), examPrepFile = path.join(dir, `${name}-exam.json`);
	patchPlannerConfig({ fixedEvents: [
		{ id: "wed", dayOfWeek: "wed", startTime: "07:15", endTime: "09:35", title: "Môn A", category: "class" },
		{ id: "thu", dayOfWeek: "thu", startTime: "07:15", endTime: "09:35", title: "Môn B", category: "class" },
		{ id: "afternoon", dayOfWeek: "thu", startTime: "13:20", endTime: "15:55", title: "Môn C", category: "class" },
	] }, { plannerFile, examPrepFile, now });
	return { plannerFile, examPrepFile, now, date };
}

it("sees and updates recurring class IDs, leaves afternoon unchanged and can undo", async () => {
	const files = fixture("weekly"); let prompt = "";
	const result = await chatWithPlannerCoachServer({ ...files, message: "Sửa ca 1 sáng thành 07:00 đến 09:40, giữ nguyên ca chiều", engineOverride: engine({
		reply: "Đã sửa.", shouldApplyChanges: true, weeklyEventOperations: [
			{ action: "update", id: "wed", startTime: "07:00", endTime: "09:40" },
			{ action: "update", id: "thu", startTime: "07:00", endTime: "09:40" },
		],
	}, (value) => { prompt = value; }) });
	assert.match(prompt, /weeklyTimetable/);
	assert.match(prompt, /Môn C/);
	assert.equal(result.snapshot.config.fixedEvents.find((e) => e.id === "wed")?.startTime, "07:00");
	assert.equal(result.snapshot.config.fixedEvents.find((e) => e.id === "thu")?.endTime, "09:40");
	assert.equal(result.snapshot.config.fixedEvents.find((e) => e.id === "afternoon")?.startTime, "13:20");
	const undone = undoPlannerCoachChangeServer({ ...files, messageId: result.assistantMessage.id });
	assert.equal(undone.undone, true);
	assert.equal(undone.snapshot.config.fixedEvents.find((e) => e.id === "wed")?.startTime, "07:15");
});

it("does not delete unless requested and refuses undo over newer user edits", async () => {
	const files = fixture("guard");
	const rejected = await chatWithPlannerCoachServer({ ...files, message: "Sửa lịch giúp mình", engineOverride: engine({ reply: "Đã xóa.", shouldApplyChanges: true, weeklyEventOperations: [{ action: "delete", id: "wed" }] }) });
	assert.ok(rejected.snapshot.config.fixedEvents.some((e) => e.id === "wed"));
	assert.match(rejected.assistantMessage.text, /chưa áp dụng/i);
	const changed = await chatWithPlannerCoachServer({ ...files, message: "Sửa ca sáng 7 giờ", engineOverride: engine({ reply: "Đã sửa.", shouldApplyChanges: true, weeklyEventOperations: [{ action: "update", id: "wed", startTime: "07:00" }] }) });
	patchPlannerConfig({ fixedEvents: changed.snapshot.config.fixedEvents.map((event) => event.id === "wed" ? { ...event, title: "Đã sửa thủ công" } : event) }, files);
	const result = undoPlannerCoachChangeServer({ ...files, messageId: changed.assistantMessage.id });
	assert.equal(result.undone, false);
	assert.equal(result.snapshot.config.fixedEvents.find((e) => e.id === "wed")?.title, "Đã sửa thủ công");
});

it("does not claim a change happened when the model submitted none", async () => {
	const files = fixture("false-claim");
	const result = await chatWithPlannerCoachServer({ ...files, message: "Sửa lịch giúp mình", engineOverride: engine({ reply: "Mình đã sửa lịch của bạn.", shouldApplyChanges: false }) });
	assert.match(result.assistantMessage.text, /chưa áp dụng/i);
	assert.equal(result.appliedChange, undefined);
});

it("updates a linked exam and the specifically requested historic journal, then undoes both", async () => {
	const files = fixture("exam");
	writeExamPrepConfig({ upsertExam: { id: "exam1", title: "Đại số", date: "2026-12-01", clusterIds: [] } }, files.examPrepFile);
	patchPlannerConfig({ milestones: [{ id: "ms1", examProfileId: "exam1", title: "Đại số", subject: "Toán", dueDate: "2026-12-01", kind: "exam", priority: 2, cognitiveLoad: "medium", clusterIds: [], estimatedHours: 12, completedHours: 0, syllabusTopics: [], notes: "" }] }, files);
	checkInPlannerHabit({ date: "2026-11-01", journalText: "Nhật ký cũ" }, files);
	let prompt = "";
	const result = await chatWithPlannerCoachServer({ ...files, message: "Sửa ngày thi thành 2026-12-02 và nhật ký 2026-11-01 thành đã nghỉ", engineOverride: engine({
		reply: "Đã sửa.", shouldApplyChanges: true,
		milestoneOperations: [{ action: "update", id: "ms1", dueDate: "2026-12-02" }],
		journalOperations: [{ action: "update", date: "2026-11-01", journalText: "đã nghỉ" }],
	}, (s) => { prompt = s; }) });
	assert.match(prompt, /Nhật ký cũ/);
	assert.equal(result.snapshot.config.logs["2026-11-01"]?.journalText, "đã nghỉ");
	assert.equal(readExamPrepConfig(files.examPrepFile).exams.find((e) => e.id === "exam1")?.date, "2026-12-02");
	assert.equal(readPlannerSnapshot(files).config.milestones.find((e) => e.id === "ms1")?.dueDate, "2026-12-02");
	const undone = undoPlannerCoachChangeServer({ ...files, messageId: result.assistantMessage.id });
	assert.equal(undone.undone, true);
	assert.equal(undone.snapshot.config.logs["2026-11-01"]?.journalText, "Nhật ký cũ");
	assert.equal(readExamPrepConfig(files.examPrepFile).exams.find((e) => e.id === "exam1")?.date, "2026-12-01");
});

it("edits an old journal without regenerating today's saved plan or removing unrelated audit data", async () => {
	const files = fixture("history");
	checkInPlannerHabit({ date: "2026-11-01", journalText: "Cũ" }, files);
	const before = readPlannerSnapshot(files).plan;
	const updated = await chatWithPlannerCoachServer({ ...files, message: "Sửa nhật ký 2026-11-01 thành Mới", engineOverride: engine({ reply: "Đã sửa.", shouldApplyChanges: true, journalOperations: [{ action: "update", date: "2026-11-01", journalText: "Mới" }] }) });
	assert.deepEqual(updated.snapshot.plan, before);
	assert.equal(updated.snapshot.config.logs["2026-11-01"]?.journalText, "Mới");
	const undo = undoPlannerCoachChangeServer({ ...files, messageId: updated.assistantMessage.id });
	assert.equal(undo.undone, true);
	assert.deepEqual(undo.snapshot.plan, before);
});

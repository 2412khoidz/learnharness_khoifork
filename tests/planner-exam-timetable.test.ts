import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { chatWithPlannerCoachServer, patchPlannerConfig, readPlannerSnapshot, undoPlannerCoachChangeServer } from "../src/server/planner.ts";
import { writeExamPrepConfig, readExamPrepConfig } from "../src/server/exam-prep.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-calendar-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const now = new Date(2026, 10, 16, 8).getTime();
function engine(args: unknown, capture: (s: string) => void = () => {}): PiEngine {
 const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
 faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", args as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
 return { model: faux.getModel(), streamFn: (model, context, options) => { capture(JSON.stringify(context)); return faux.streamSimple(model, context, options); } };
}
function fixture(name: string) { return { plannerFile: path.join(dir, name + ".json"), examPrepFile: path.join(dir, name + "-exam.json"), now, date: "2026-11-16" }; }
it("stores undated or incomplete exams separately; only complete times block the schedule", () => {
 const f = fixture("calendar");
 const snap = patchPlannerConfig({ examTimetable: [
  { id: "x", title: "Undated" }, { id: "y", title: "Start only", date: f.date, startTime: "13:00" },
  { id: "z", title: "Exam", date: f.date, startTime: "15:00", endTime: "17:00", location: "103-A" },
 ] }, f);
 assert.equal(snap.config.examTimetable.length, 3);
 assert.equal(snap.config.examTimetable[1]?.endTime, undefined);
 assert.equal(snap.config.milestones.length, 0);
 assert.ok(snap.plan.blocks.some((block) => block.title === "Exam" && block.startTime === "15:00" && block.endTime === "17:00"));
 assert.ok(!snap.plan.blocks.some((block) => block.title === "Start only"));
 assert.ok(snap.plan.blocks.filter((block) => block.type === "study").every((block) => block.endMin <= 900 || block.startMin >= 1020));
});
it("Coach can add/update a separate exam and undo; raw dates without end remain incomplete", async () => {
 const f = fixture("coach"); let prompt = "";
 const result = await chatWithPlannerCoachServer({ ...f, message: "Thêm lịch thi Đại số, 2026-11-16 lúc 14:00", engineOverride: engine({ reply: "Đã thêm", shouldApplyChanges: true, examTimetableOperations: [{ action: "add", title: "Đại số", date: f.date, startTime: "14:00" }] }, (v) => { prompt = v; }) });
 assert.match(prompt, /examTimetable/); assert.equal(result.snapshot.config.examTimetable[0]?.endTime, undefined);
 assert.equal(result.snapshot.config.milestones.length, 0); assert.equal(readExamPrepConfig(f.examPrepFile).exams.length, 0);
 assert.equal(undoPlannerCoachChangeServer({ ...f, messageId: result.assistantMessage.id }).snapshot.config.examTimetable.length, 0);
});
it("deleting a named milestone never deletes its linked profile; unrelated deletion is rejected", async () => {
 const f = fixture("delete"); writeExamPrepConfig({ upsertExam: { id: "p1", title: "Môn A", date: "2026-12-01", clusterIds: [] } }, f.examPrepFile);
 patchPlannerConfig({ milestones: [{ id: "m1", examProfileId: "p1", title: "Môn A", subject: "A", dueDate: "2026-12-01", kind: "exam", priority: 2, cognitiveLoad: "medium", clusterIds: [], estimatedHours: 12, completedHours: 0, syllabusTopics: [], notes: "" }], fixedEvents: [{ id: "a", dayOfWeek: "wed", startTime: "07:00", endTime: "09:00", title: "Môn A", category: "class" }, { id: "b", dayOfWeek: "thu", startTime: "07:00", endTime: "09:00", title: "Môn B", category: "class" }] }, f);
 const result = await chatWithPlannerCoachServer({ ...f, message: "Xóa Môn A, giữ Môn B", engineOverride: engine({ reply: "Đã xóa", shouldApplyChanges: true, weeklyEventOperations: [{ action: "delete", id: "b" }], milestoneOperations: [{ action: "delete", id: "m1" }] }) });
 assert.ok(result.snapshot.config.fixedEvents.some((e) => e.id === "b"));
 assert.ok(readExamPrepConfig(f.examPrepFile).exams.some((e) => e.id === "p1"));
 assert.ok(!readPlannerSnapshot(f).config.milestones.some((m) => m.id === "m1"));
});
it("preserves complete exams against custom study blocks and keeps unfinished exams unscheduled", () => {
 const f = fixture("custom");
 const base = patchPlannerConfig({ examTimetable: [{ id: "exam", title: "Thi toán", date: f.date, startTime: "15:00", endTime: "16:00" }, { id: "unknown", title: "Thi lý", date: f.date, startTime: "17:00" }] }, f);
 const study = { id: "custom", date: f.date, startTime: "14:30", endTime: "16:30", startMin: 870, endMin: 990, durationMin: 120, type: "study" as const, title: "Ôn tập", subject: "Toán" };
 const result = patchPlannerConfig({ dayOverrides: { [f.date]: { date: f.date, customBlocks: [study] } } }, f);
 assert.ok(result.plan.blocks.some((block) => block.id === "blk_exam_exam"));
 assert.deepEqual(result.plan.blocks.filter((block) => block.type === "study").map((block) => [block.startTime, block.endTime]), [["14:30", "15:00"], ["16:00", "16:30"]]);
 assert.equal(result.plan.quotas[0]?.targetMin, 60);
 assert.equal(base.config.examTimetable[1]?.endTime, undefined);
});
it("keeps attachment-only messages and metadata after loading the saved planner", async () => {
 const f = fixture("attachment"); let prompt = "";
 const attachment = { id: "file-1", name: "exam.txt", mimeType: "text/plain", size: 42 };
 await chatWithPlannerCoachServer({ ...f, message: "", attachments: [attachment], attachmentText: "Văn bản lịch thi", engineOverride: engine({ reply: "Tôi đã xem tệp.", shouldApplyChanges: false }, (value) => { prompt = value; }) });
 assert.match(prompt, /Văn bản lịch thi/);
 const saved = readPlannerSnapshot(f).config.coachChat?.find((message) => message.role === "user");
 assert.deepEqual(saved?.attachments, [attachment]);
});
import { applyLlmPlanOutput, computeLocalPlannerPlan, sanitizePlannerConfig } from "../src/core/planner.ts";
it("AI cannot place study over an exam and repeated planning does not duplicate the exam", () => {
 const f = fixture("ai-block");
 const snapshot = patchPlannerConfig({ examTimetable: [{ id: "exam", title: "Exam", date: f.date, startTime: "15:00", endTime: "16:00" }] }, f);
 const draft = applyLlmPlanOutput(snapshot.plan, { coachSummary: "Test", blocks: [{ startTime: "15:10", endTime: "15:50", type: "study", title: "Conflict" }, { startTime: "16:10", endTime: "16:50", type: "study", title: "Allowed" }] }, snapshot.config, "fake", { now });
 assert.ok(!draft.blocks.some((block) => block.title === "Conflict"));
 assert.equal(draft.blocks.filter((block) => block.id === "blk_exam_exam").length, 1);
 const config = sanitizePlannerConfig({ ...snapshot.config, dayOverrides: { [f.date]: { date: f.date, customBlocks: draft.blocks } } });
 for (let i = 0; i < 2; i++) {
  const result = computeLocalPlannerPlan(config, snapshot.signals, now);
  assert.equal(result.blocks.filter((block) => block.id === "blk_exam_exam").length, 1);
 }
});
it("rejects images when the selected model lacks vision before saving a message", async () => {
 const f = fixture("no-vision"); const noVision = engine({ reply: "OK", shouldApplyChanges: false });
 noVision.model = { ...noVision.model, input: ["text"] };
 await assert.rejects(chatWithPlannerCoachServer({ ...f, message: "Xem ảnh", attachments: [{ id: "a", name: "image.png", mimeType: "image/png", size: 1 }], images: [{ type: "image", mimeType: "image/png", data: "AA==" }], engineOverride: noVision }), /does not support images/i);
 assert.equal(readPlannerSnapshot(f).config.coachChat?.length ?? 0, 0);
});
it("passes a supported image to the Coach model", async () => {
 const f = fixture("vision"); let prompt = "";
 const vision = engine({ reply: "Ảnh lịch thi", shouldApplyChanges: false }, (value) => { prompt = value; });
 vision.model = { ...vision.model, input: ["text", "image"] };
 const png = createCanvas(8, 8).toBuffer("image/png").toString("base64");
 await chatWithPlannerCoachServer({ ...f, message: "Xem ảnh", attachments: [{ id: "a", name: "image.png", mimeType: "image/png", size: 68 }], images: [{ type: "image", mimeType: "image/png", data: png }], engineOverride: vision });
 assert.match(prompt, /\"type\":\"image\"/);
});
it("keeps older attachment messages after more than 30 messages while only sending recent chat context", async () => {
 const f = fixture("long-history");
 const attachment = { id: "history-file", name: "exam.txt", mimeType: "text/plain", size: 42 };
 await chatWithPlannerCoachServer({ ...f, message: "Old context unique marker", attachments: [attachment], attachmentText: "Exam information", engineOverride: engine({ reply: "Viewed.", shouldApplyChanges: false }) });
 for (let i = 0; i < 16; i++) {
  await chatWithPlannerCoachServer({ ...f, message: `Message ${i}`, engineOverride: engine({ reply: `Reply ${i}`, shouldApplyChanges: false }) });
 }
 let prompt = "";
 await chatWithPlannerCoachServer({ ...f, message: "Last message", engineOverride: engine({ reply: "Done", shouldApplyChanges: false }, (value) => { prompt = value; }) });
 const messages = readPlannerSnapshot(f).config.coachChat ?? [];
 assert.equal(messages.length, 36);
 assert.deepEqual(messages[0]?.attachments, [attachment]);
 assert.equal(messages[0]?.text, "Old context unique marker");
 assert.doesNotMatch(prompt, /Old context unique marker/);
 assert.match(prompt, /Message 15/);
});
it("preserves the full exam interval outside wake and wind-down bounds", () => {
 const f = fixture("outside-awake");
 const date = f.date;
 const study = (id: string, startMin: number, endMin: number) => ({ id, date, startTime: `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`, endTime: `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`, startMin, endMin, durationMin: endMin - startMin, type: "study" as const, title: id, subject: "Subject" });
 const snapshot = patchPlannerConfig({ examTimetable: [{ id: "early", title: "Early exam", date, startTime: "06:00", endTime: "07:00" }, { id: "late", title: "Late exam", date, startTime: "23:10", endTime: "23:50" }], dayOverrides: { [date]: { date, customBlocks: [study("early-study", 350, 380), study("late-study", 1380, 1410)] } } }, f);
 const early = snapshot.plan.blocks.find((b) => b.id === "blk_exam_early");
 const late = snapshot.plan.blocks.find((b) => b.id === "blk_exam_late");
 assert.deepEqual([early?.startTime, early?.endTime, late?.startTime, late?.endTime], ["06:00", "07:00", "23:10", "23:50"]);
 for (const block of snapshot.plan.blocks.filter((b) => b.type === "study")) for (const exam of [early!, late!]) assert.ok(block.endMin <= exam.startMin || block.startMin >= exam.endMin);
 const generated = applyLlmPlanOutput(snapshot.plan, { coachSummary: "Schedule", blocks: [{ startTime: "06:30", endTime: "06:50", type: "study", title: "Too early" }, { startTime: "23:15", endTime: "23:35", type: "study", title: "Too late" }] }, snapshot.config, "fake");
 assert.ok(!generated.blocks.some((b) => b.title === "Too early" || b.title === "Too late"));
});
it("refuses ambiguous deletion of a substring or two identically named entries", async () => {
 const f = fixture("ambiguous-delete");
 patchPlannerConfig({ examTimetable: [{ id: "short", title: "Toán" }, { id: "long", title: "Toán cao cấp" }, { id: "dup1", title: "Vật lý" }, { id: "dup2", title: "Vật lý" }, { id: "suffix", title: "Cao cấp" }] }, f);
 const shorter = await chatWithPlannerCoachServer({ ...f, message: "Xóa Toán cao cấp", engineOverride: engine({ reply: "Đã xóa", shouldApplyChanges: true, examTimetableOperations: [{ action: "delete", id: "short" }] }) });
 assert.equal(shorter.snapshot.config.examTimetable.length, 5);
 const suffix = await chatWithPlannerCoachServer({ ...f, message: "Xóa Toán cao cấp", engineOverride: engine({ reply: "Đã xóa", shouldApplyChanges: true, examTimetableOperations: [{ action: "delete", id: "suffix" }] }) });
 assert.equal(suffix.snapshot.config.examTimetable.length, 5);
 const duplicated = await chatWithPlannerCoachServer({ ...f, message: "Xóa Vật lý", engineOverride: engine({ reply: "Đã xóa", shouldApplyChanges: true, examTimetableOperations: [{ action: "delete", id: "dup1" }] }) });
 assert.equal(duplicated.snapshot.config.examTimetable.length, 5);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-audit-"));
process.env.LH_DATA_DIR = dir;
after(() => { const target = fs.realpathSync(dir); if (!target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error("Invalid test directory"); fs.rmSync(target, { recursive: true, force: true }); });

it("audits all answers without mutation, applies selected reviews and restores them on undo", async () => {
 const { stores } = await import("../src/server/stores.ts");
 const { collectRecallCandidates } = await import("../src/core/mistakes.ts");
 const { recallAuditPreview, startRecallAudit, recallAudits, applyRecallAudit, undoRecallAudit, recallAuditEngineOverride } = await import("../src/server/recall-audit.ts");
 const { readRecallOverrides } = await import("../src/server/recall-overrides.ts");
 const { writeMistakes, readMistakes } = await import("../src/store/mistakes.ts");
 const { readMistakeDismissals, isDismissedMistake } = await import("../src/store/mistake-dismissals.ts");
 const chat = stores.chatStore.createChat("Synthetic mathematics");
 const when = Date.parse("2026-01-01T09:00:00Z");
 const messages = ["one", "two"].map((id) => ({ role: "toolResult", toolName: "recall", toolCallId: id, timestamp: when, details: { kind: "explain", questionText: `Question ${id}`, text: "A correct response", committed: "A correct response", answeredAt: new Date(when).toISOString() }, content: [] })) as unknown as LhMessage[];
 stores.chatStore.saveMessages(chat.id, messages);
 const drafts = collectRecallCandidates(chat.id, messages).map((item) => item.draft);
 assert.equal(drafts.length, 2);
 fs.writeFileSync(path.join(dir, "recall-scan.json"), JSON.stringify({ version: 1, status: "complete", total: 2, results: drafts.map((draft) => ({ id: draft.id, draft, sessionTitle: chat.title, verdict: "partial", strengths: "", missing: "Old feedback", correction: "", evidence: "", errorType: "knowledge-gap", topic: "Synthetic", rule: "" })) }));
 writeMistakes([{ ...drafts[0]!, sessionTitle: chat.title, sessionKind: "teach", sources: [], createdAt: new Date(when).toISOString(), status: "ready" }]);
 const preview = recallAuditPreview();
 assert.equal(preview.count, 2);
 const fake = createFauxCore({ tokenSize: { min: 64, max: 64 } });
 fake.setResponses([fauxAssistantMessage([fauxToolCall("submit_recall_assessments", { items: drafts.map((draft) => ({ id: draft.id, verdict: "correct", strengths: "Correct", missing: "", correction: "", evidence: "The response is correct.", errorType: "knowledge-gap", topic: "Synthetic", rule: "" })) } as ToolCall["arguments"], { id: "audit" })], { stopReason: "toolUse" })]);
 recallAuditEngineOverride.current = { model: fake.getModel(), streamFn: fake.streamSimple };
 const run = startRecallAudit({ expected: preview.items.map((item) => ({ id: item.draft.id, fingerprint: item.fingerprint })) });
 for (let i = 0; i < 100 && recallAudits().find((item) => item.id === run.id)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
 const complete = recallAudits().find((item) => item.id === run.id)!;
 assert.equal(complete.status, "complete"); assert.equal(complete.results.length, 2);
 assert.equal(readRecallOverrides().length, 0); assert.equal(readMistakes().length, 1);
 assert.equal(fs.existsSync(path.join(dir, "recall-fsrs.json")), false);
 const applied = applyRecallAudit(run.id, [{ id: drafts[0]!.id, removeMistake: true }]);
 assert.equal(applied.applied, 1); assert.equal(readRecallOverrides()[0]?.verdict, "correct"); assert.equal(readMistakes().length, 0);
 assert.equal(isDismissedMistake(drafts[0]!, readMistakeDismissals()), true, "an explicitly removed mistake is not silently re-added");
 assert.equal(undoRecallAudit(run.id, applied.reviewId).undone, 1); assert.equal(readRecallOverrides().length, 0); assert.equal(readMistakes().length, 1);
 assert.equal(isDismissedMistake(drafts[0]!, readMistakeDismissals()), false, "undo also restores dismissal state");
 assert.equal(fs.existsSync(path.join(dir, "recall-fsrs.json")), false);
 recallAuditEngineOverride.current = undefined;
});

it("saves successful audit batches and resumes only the unfinished answers after an error", async () => {
 const { stores } = await import("../src/server/stores.ts");
 const { recallAuditPreview, startRecallAudit, recallAudits, resumeRecallAudit, applyRecallAudit, undoRecallAudit, recallAuditEngineOverride } = await import("../src/server/recall-audit.ts");
 const chat = stores.chatStore.createChat("Synthetic unassigned audit");
 const when = Date.parse("2026-01-01T10:00:00Z");
 const messages = Array.from({ length: 7 }, (_, i) => ({ role: "toolResult", toolName: "recall", toolCallId: `extra${i}`, timestamp: when, details: { kind: "explain", questionText: `Question ${i}`, text: "Answer", committed: "Answer", answeredAt: new Date(when).toISOString() }, content: [] })) as unknown as LhMessage[];
 stores.chatStore.saveMessages(chat.id, messages);
 const preview = recallAuditPreview();
 assert.equal(preview.count, 9);
 const grade = (id: string) => ({ id, verdict: "uncertain", strengths: "", missing: "", correction: "", evidence: "Not enough evidence.", errorType: "knowledge-gap", topic: "Synthetic", rule: "" });
 const fake = createFauxCore({ tokenSize: { min: 64, max: 64 } });
 fake.setResponses([fauxAssistantMessage([fauxToolCall("submit_recall_assessments", { items: preview.items.slice(0, 8).map((item) => grade(item.draft.id)) } as ToolCall["arguments"], { id: "first" })], { stopReason: "toolUse" }), fauxAssistantMessage("", { stopReason: "error", errorMessage: "quota exceeded" })]);
 recallAuditEngineOverride.current = { model: fake.getModel(), streamFn: fake.streamSimple };
 const run = startRecallAudit({ expected: preview.items.map(({ draft, fingerprint }) => ({ id: draft.id, fingerprint })) });
 for (let i = 0; i < 100 && recallAudits().find((item) => item.id === run.id)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
 const partial = recallAudits().find((item) => item.id === run.id)!;
 assert.equal(partial.status, "error"); assert.equal(partial.results.length, 8);
 const resumed = createFauxCore({ tokenSize: { min: 64, max: 64 } });
 resumed.setResponses([fauxAssistantMessage([fauxToolCall("submit_recall_assessments", { items: [grade(preview.items[8]!.draft.id)] } as ToolCall["arguments"], { id: "last" })], { stopReason: "toolUse" })]);
 recallAuditEngineOverride.current = { model: resumed.getModel(), streamFn: resumed.streamSimple };
 resumeRecallAudit(run.id);
 for (let i = 0; i < 100 && recallAudits().find((item) => item.id === run.id)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
 const complete = recallAudits().find((item) => item.id === run.id)!;
 assert.equal(complete.status, "complete"); assert.equal(complete.results.length, 9);
 assert.equal(new Set(complete.results.map((item) => item.id)).size, 9);
 const reviewed = applyRecallAudit(run.id, [{ id: preview.items[8]!.draft.id }]);
 assert.equal(reviewed.applied, 1, "uncertain may be explicitly accepted without becoming a wrong answer");
 undoRecallAudit(run.id, reviewed.reviewId);
 recallAuditEngineOverride.current = undefined;
});


it("persists review selections across server reads and rejects older out-of-order saves", async () => {
 const { readReviewProgress, saveReviewProgress } = await import("../src/server/recall-review-progress.ts");
 const key = "group:Synthetic subject";
 const value = { groups: [{ id: "group-1", name: "Edited" }], approved: { "group-1": true }, splitSelection: { "answer-1": true }, revision: "original" };
 saveReviewProgress(key, 200, value);
 saveReviewProgress(key, 199, { groups: [] });
 assert.deepEqual(readReviewProgress(key), { sequence: 200, value });
 assert.equal(readReviewProgress("audit:other"), null);
 assert.throws(() => saveReviewProgress("unknown:key", 201, value), /Invalid/);
});

it("splits recoverable failures, saves successful answers, skips one bad answer and continues", async () => {
 const { recallAuditPreview, startRecallAudit, recallAudits, recallAuditEngineOverride } = await import("../src/server/recall-audit.ts");
 const preview = recallAuditPreview(); assert.equal(preview.count, 9);
 const grade = (id: string) => ({ id, verdict: "correct", strengths: "Supported", missing: "", correction: "", evidence: "The answer is supported.", errorType: "knowledge-gap", topic: "Synthetic", rule: "" });
 const success = (ids: string[]) => fauxAssistantMessage([fauxToolCall("submit_recall_assessments", { items: ids.map(grade) } as ToolCall["arguments"], { id: `s${ids.length}` })], { stopReason: "toolUse" });
 const bad = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "Incomplete JSON segment at the end" });
 const ids = preview.items.map((item) => item.draft.id);
 const fake = createFauxCore({ tokenSize: { min: 64, max: 64 } });
 fake.setResponses([bad(), bad(), success(ids.slice(0, 2)), bad(), bad(), success(ids.slice(3, 4)), success(ids.slice(4, 8)), success(ids.slice(8, 9))]);
 recallAuditEngineOverride.current = { model: fake.getModel(), streamFn: fake.streamSimple };
 const run = startRecallAudit({ expected: preview.items.map(({ draft, fingerprint }) => ({ id: draft.id, fingerprint })) });
 for (let i = 0; i < 300 && recallAudits().find((item) => item.id === run.id)?.status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
 const result = recallAudits().find((item) => item.id === run.id)!;
 assert.equal(result.status, "complete"); assert.equal(result.results.length, 8); assert.equal(result.skipped?.length, 1);
 assert.equal(result.skipped?.[0]?.id, ids[2]); assert.ok(result.results.some((item) => item.id === ids[8]));
 recallAuditEngineOverride.current = undefined;
});

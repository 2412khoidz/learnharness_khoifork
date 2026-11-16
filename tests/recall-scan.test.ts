import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { collectRecallCandidates, findMistakes } from "../src/core/mistakes.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-recall-scan-"));
process.env.LH_DATA_DIR = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const call = (id: string, name: string, args: unknown): LhMessage => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 1 }) as LhMessage;
const result = (id: string, name: string, details: unknown): LhMessage => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], details, timestamp: 1 }) as LhMessage;
const answer = (id: string): LhMessage[] => [
	call(id, "explain", { committedAnswer: "A proof" }),
	result(id, "explain", { kind: "explain", questionText: `Question ${id}`, text: `Answer ${id}`, committed: "A proof", answeredAt: "2026-01-01T10:00:00Z" }),
	{ role: "assistant", content: [{ type: "text", text: "Some feedback" }], timestamp: 1 } as LhMessage,
];
const engine = (steps: Array<ReturnType<typeof fauxAssistantMessage>>): PiEngine => {
	const core = createFauxCore({ tokenSize: { min: 64, max: 64 } }); core.setResponses(steps); return { model: core.getModel(), streamFn: core.streamSimple };
};
const submit = (items: unknown[]) => fauxAssistantMessage([fauxToolCall("submit_recall_assessments", { items } as ToolCall["arguments"], { id: "grade" })], { stopReason: "toolUse" });
const assessment = (id: string, verdict: string) => ({ id, verdict, strengths: "Some valid work", missing: "A condition was missing", correction: "Include the condition", evidence: "Answer", errorType: "incomplete-reasoning", topic: "Proof", rule: "Check the condition" });
const until = async (predicate: () => boolean) => {
	for (let n = 0; n < 200 && !predicate(); n++) await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(predicate());
};

it("pairs free recall with feedback and never records correct or uncertain flags as mistakes", () => {
	const messages = [...answer("a"), call("flag1", "flag_mistake", { verdict: "correct", summary: "Right" }), result("flag1", "flag_mistake", { targetToolCallId: "a", verdict: "correct", summary: "Right" })];
	const found = collectRecallCandidates("chat", messages);
	assert.equal(found.length, 1);
	assert.equal(found[0]!.feedback, "Some feedback");
	assert.equal(findMistakes("chat", messages).length, 0);
});

it("scans batches, resumes after failure and saves only selected misses once", async () => {
	const { chatStore } = await import("../src/store/chats.ts");
	const scan = await import("../src/server/recall-scan.ts");
	const { readMistakes } = await import("../src/store/mistakes.ts");
	const chat = chatStore.createChat("Recall test");
	chatStore.saveMessages(chat.id, Array.from({ length: 6 }, (_, i) => answer(`q${i}`)).flat());
	const ids = Array.from({ length: 6 }, (_, i) => `${chat.id}:q${i}`);
	scan.recallScanEngineOverride.current = engine([submit(ids.slice(0, 5).map((id, i) => assessment(id, i === 0 ? "correct" : i === 1 ? "uncertain" : "partial"))), fauxAssistantMessage("No result")]);
	scan.startRecallScan();
	await until(() => scan.recallScanStatus().status === "error");
	assert.equal(scan.recallScanStatus().results.length, 5);
	assert.equal(readMistakes().length, 0, "scanning does not save mistakes");
	scan.recallScanEngineOverride.current = engine([submit([assessment(ids[5]!, "wrong")])]);
	scan.startRecallScan();
	await until(() => scan.recallScanStatus().status === "complete");
	assert.equal(scan.recallScanStatus().results.length, 6);
	assert.equal(scan.saveRecallScanResults([ids[0]!, ids[1]!, ids[2]!, ids[5]!]), 2);
	assert.equal(readMistakes().length, 2);
	assert.equal(readMistakes()[0]?.verdict, "partial");
	assert.equal(readMistakes()[0]?.strengths, "Some valid work");
	assert.equal(scan.saveRecallScanResults([ids[2]!, ids[5]!]), 0);
	assert.equal(readMistakes().length, 2);

	// Interrupt a new batch; restarting resumes it rather than discarding the
	// six assessments already collected.
	const extra = chatStore.createChat("Interrupted scan");
	chatStore.saveMessages(extra.id, answer("later"));
	const extraId = `${extra.id}:later`;
	scan.recallScanEngineOverride.current = engine([submit([assessment(extraId, "partial")])]);
	scan.startRecallScan();
	scan.pauseRecallScan();
	await until(() => scan.recallScanStatus().status === "paused");
	assert.equal(scan.recallScanStatus().results.length, 6);
	scan.recallScanEngineOverride.current = engine([submit([assessment(extraId, "partial")])]);
	scan.startRecallScan();
	await until(() => scan.recallScanStatus().status === "complete");
	assert.equal(scan.recallScanStatus().results.length, 7);
});

it("independently assesses the current free-recall answer when the tutor omits its marker", async () => {
	const { chatStore } = await import("../src/store/chats.ts");
	const scan = await import("../src/server/recall-scan.ts");
	const { readMistakes } = await import("../src/store/mistakes.ts");
	const chat = chatStore.createChat("Live recall");
	chatStore.saveMessages(chat.id, answer("current"));
	const id = `${chat.id}:current`;
	const before = readMistakes().length;
	scan.recallScanEngineOverride.current = engine([submit([assessment(id, "partial")])]);
	scan.gradeLatestRecallAfterTurn(chat.id);
	await until(() => scan.liveRecallGrades(chat.id).some((grade) => grade.id === id));
	assert.equal(scan.liveRecallGrades(chat.id)[0]?.verdict, "partial");
	assert.equal(readMistakes().length, before + 1);
	assert.equal(readMistakes().find((record) => record.id === id)?.strengths, "Some valid work");
	scan.gradeLatestRecallAfterTurn(chat.id);
	assert.equal(readMistakes().length, before + 1, "a second turn does not duplicate the assessment");

	const correctChat = chatStore.createChat("Correct live recall");
	chatStore.saveMessages(correctChat.id, answer("correct"));
	const correctId = `${correctChat.id}:correct`;
	scan.recallScanEngineOverride.current = engine([submit([assessment(correctId, "correct")])]);
	scan.gradeLatestRecallAfterTurn(correctChat.id);
	await until(() => scan.liveRecallGrades(correctChat.id).some((grade) => grade.id === correctId));
	assert.equal(readMistakes().length, before + 1, "a correct answer is assessed but is not a mistake");
});

it("splits invalid batches down to individual answers while saving successful work and usage", async () => {
	const { chatStore } = await import("../src/store/chats.ts");
	const scan = await import("../src/server/recall-scan.ts");
	const extra = chatStore.createChat("Batch fallback");
	chatStore.saveMessages(extra.id, [answer("split1"), answer("split2"), answer("split3")].flat());
	const previous = scan.recallScanStatus();
	const seen = new Set(previous.results.map((r) => r.id));
	const pending = chatStore.listChats().flatMap((chat) => {
		const record = chatStore.getChat(chat.id);
		return record ? collectRecallCandidates(record.id, record.messages).map((c) => c.draft.id) : [];
	}).filter((id) => !seen.has(id));
	assert.equal(pending.length, 5);
	const grade = (ids: string[]) => submit(ids.map((id) => assessment(id, "partial")));
	scan.recallScanEngineOverride.current = engine([
		fauxAssistantMessage("No structured result"), // 5 fails
		grade(pending.slice(0, 2)),                    // 2 succeeds
		fauxAssistantMessage("No structured result"), // 3 fails
		grade(pending.slice(2, 3)),                    // 1 succeeds
		grade(pending.slice(3, 5)),                    // 2 succeeds
	]);
	scan.startRecallScan();
	await until(() => scan.recallScanStatus().status !== "running");
	const final = scan.recallScanStatus();
	assert.equal(final.status, "complete");
	assert.deepEqual(new Set(final.results.map((r) => r.id)), new Set([...seen, ...pending]));
	assert.equal(final.results.length, previous.results.length + pending.length, "no duplicate assessments");
	assert.ok((final.usage?.modelCalls ?? 0) >= (previous.usage?.modelCalls ?? 0) + 5, "failed and successful requests are counted");
});

it("stops on a single unassessable answer and resumes after the successful split", async () => {
	const { chatStore } = await import("../src/store/chats.ts");
	const scan = await import("../src/server/recall-scan.ts");
	const chat = chatStore.createChat("Unassessable answer");
	chatStore.saveMessages(chat.id, Array.from({ length: 5 }, (_, i) => answer(`leaf${i}`)).flat());
	const before = scan.recallScanStatus();
	const ids = Array.from({ length: 5 }, (_, i) => `${chat.id}:leaf${i}`);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([
		fauxAssistantMessage("No result"),
		submit(ids.slice(0, 2).map((id) => assessment(id, "partial"))),
		fauxAssistantMessage("No result"),
		fauxAssistantMessage("No result"),
	]);
	scan.recallScanEngineOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };
	scan.startRecallScan();
	await until(() => scan.recallScanStatus().status === "error");
	assert.equal(faux.state.callCount, 4, "the failed single answer must not be retried indefinitely");
	assert.equal(scan.recallScanStatus().results.length, before.results.length + 2);
	scan.recallScanEngineOverride.current = engine([submit(ids.slice(2).map((id) => assessment(id, "partial")))]);
	scan.startRecallScan();
	await until(() => scan.recallScanStatus().status === "complete");
	assert.equal(scan.recallScanStatus().results.length, before.results.length + 5);
});

it("does not split or retry a provider error", async () => {
	const { chatStore } = await import("../src/store/chats.ts");
	const scan = await import("../src/server/recall-scan.ts");
	const chat = chatStore.createChat("Provider error");
	chatStore.saveMessages(chat.id, [answer("provider1"), answer("provider2")].flat());
	const before = scan.recallScanStatus().results.length;
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic provider failure" })]);
	scan.recallScanEngineOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };
	scan.startRecallScan();
	await until(() => scan.recallScanStatus().status === "error");
	assert.equal(faux.state.callCount, 1);
	assert.equal(scan.recallScanStatus().error, "Synthetic provider failure");
	assert.equal(scan.recallScanStatus().results.length, before);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-session-approval-"));
process.env.LH_DATA_DIR = dir;
after(() => { const resolved = fs.realpathSync(dir); if (!resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error("Unexpected temporary path"); fs.rmSync(resolved, { recursive: true, force: true }); });

it("reviews a session metadata edit, applies only on confirmation and can undo", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot, undoPlannerCoachChangeServer } = await import("../src/server/planner.ts");
	const chat = stores.chatStore.createChat("Original title");
	stores.chatStore.updateChatMeta!(chat.id, { notes: "Original note" });
	const plannerFile = path.join(dir, "planner-test.json");
	const now = new Date(2026, 10, 16, 12).getTime();
	const date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Đổi tên phiên.", shouldApplyChanges: true, sessionOperations: [{ id: chat.id, title: "New title", notes: "New note" }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Đổi tên và sửa ghi chú phiên học", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal?.changes.sessions);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "Original title");
	const applied = confirmPlannerCoachProposal(result.proposal.id);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "New title");
	assert.equal(stores.chatStore.getChat(chat.id)?.notes, "New note");
	assert.equal(undoPlannerCoachChangeServer({ plannerFile, now, date, messageId: applied.assistantMessage.id }).undone, true);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "Original title");
	assert.equal(stores.chatStore.getChat(chat.id)?.notes, "Original note");
});

it("does not overwrite a session edited while approval is pending", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot } = await import("../src/server/planner.ts");
	const chat = stores.chatStore.createChat("Session title");
	const plannerFile = path.join(dir, "planner-stale.json");
	const now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Đổi tên phiên.", shouldApplyChanges: true, sessionOperations: [{ id: chat.id, title: "AI title" }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Đổi tên phiên học", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal);
	stores.chatStore.renameChat(chat.id, "User title");
	assert.throws(() => confirmPlannerCoachProposal(result.proposal!.id), /session changed/i);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "User title");
});

it("previews a graph concept correction, preserves provenance, and undoes it", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot, undoPlannerCoachChangeServer } = await import("../src/server/planner.ts");
	const node = { id: "test_graph_node", name: "Original", statement: "Original statement", aliases: ["alias"], createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId: "source", messageId: "message" }] };
	stores.graphStore.appendNode(node);
	const plannerFile = path.join(dir, "planner-graph.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Sửa tên khái niệm.", shouldApplyChanges: true, graphNodeOperations: [{ id: node.id, name: "Corrected" }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Sửa tên khái niệm", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal?.changes.graph);
	assert.equal(stores.graphStore.readNodes().find((item) => item.id === node.id)?.name, "Original");
	const applied = confirmPlannerCoachProposal(result.proposal.id);
	assert.deepEqual(stores.graphStore.readNodes().find((item) => item.id === node.id), { ...node, name: "Corrected" });
	assert.equal(undoPlannerCoachChangeServer({ plannerFile, now, date, messageId: applied.assistantMessage.id }).undone, true);
	assert.deepEqual(stores.graphStore.readNodes().find((item) => item.id === node.id), node);
});

it("rejects graph approval after provenance changes", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot } = await import("../src/server/planner.ts");
	const node = { id: "test_graph_stale", name: "Original", statement: "Statement", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [] };
	stores.graphStore.appendNode(node);
	const plannerFile = path.join(dir, "planner-graph-stale.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Sửa tên.", shouldApplyChanges: true, graphNodeOperations: [{ id: node.id, name: "New name" }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Sửa tên khái niệm", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal);
	stores.graphStore.appendNode({ ...node, aliases: ["new evidence"] });
	assert.throws(() => confirmPlannerCoachProposal(result.proposal!.id), /graph concept changed/i);
	assert.equal(stores.graphStore.readNodes().filter((item) => item.id === node.id).length, 2);
	assert.equal(stores.graphStore.readNodes().find((item) => item.id === node.id)?.name, "Original");
});

it("refuses a graph rewrite if the ledger contains an unreadable line", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { LEDGER_FILES } = await import("../config.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot } = await import("../src/server/planner.ts");
	const node = { id: "test_graph_corrupt", name: "Original", statement: "Statement", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [] };
	stores.graphStore.appendNode(node);
	const plannerFile = path.join(dir, "planner-graph-corrupt.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Sửa tên.", shouldApplyChanges: true, graphNodeOperations: [{ id: node.id, name: "New name" }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Sửa tên khái niệm", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal);
	assert.ok(fs.realpathSync(path.dirname(LEDGER_FILES.nodes)).startsWith(fs.realpathSync(dir) + path.sep));
	const original = fs.readFileSync(LEDGER_FILES.nodes, "utf8");
	try {
		fs.appendFileSync(LEDGER_FILES.nodes, "not-json\n");
		assert.throws(() => confirmPlannerCoachProposal(result.proposal!.id), /unreadable/i);
		assert.ok(fs.readFileSync(LEDGER_FILES.nodes, "utf8").endsWith("not-json\n"));
	} finally { fs.writeFileSync(LEDGER_FILES.nodes, original); }
});

it("previews a validated setting, then applies and undoes it", async () => {
	const { readSettings, writeSettings } = await import("../src/store/settings.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot, undoPlannerCoachChangeServer } = await import("../src/server/planner.ts");
	writeSettings({ version: 1, general: { autoUpdate: true } });
	const plannerFile = path.join(dir, "planner-settings.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Đổi cài đặt.", shouldApplyChanges: true, settingsOperations: [{ section: "general", patchJson: '{"autoUpdate":false}' }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Tắt tự cập nhật", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal?.changes.settings);
	assert.equal(readSettings()?.general?.autoUpdate, true);
	const applied = confirmPlannerCoachProposal(result.proposal.id);
	assert.equal(readSettings()?.general?.autoUpdate, false);
	assert.equal(undoPlannerCoachChangeServer({ plannerFile, now, date, messageId: applied.assistantMessage.id }).undone, true);
	assert.equal(readSettings()?.general?.autoUpdate, true);
});

it("rejects a settings proposal when settings change during review", async () => {
	const { readSettings, writeSettings } = await import("../src/store/settings.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot } = await import("../src/server/planner.ts");
	writeSettings({ version: 1, general: { autoUpdate: true } });
	const plannerFile = path.join(dir, "planner-settings-stale.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Đổi cài đặt.", shouldApplyChanges: true, settingsOperations: [{ section: "general", patchJson: '{"autoUpdate":false}' }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Tắt tự cập nhật", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal);
	writeSettings({ version: 1, general: { autoUpdate: true }, claudeCode: { enabled: true } });
	assert.throws(() => confirmPlannerCoachProposal(result.proposal!.id), /settings changed/i);
	assert.equal(readSettings()?.general?.autoUpdate, true);
	assert.equal(readSettings()?.claudeCode?.enabled, true);
});

it("merges a nested appearance change without deleting other preferences", async () => {
	const { readSettings, writeSettings } = await import("../src/store/settings.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot, undoPlannerCoachChangeServer } = await import("../src/server/planner.ts");
	writeSettings({ version: 1, appearance: { colors: { surface: "#112233", accent: "#445566" }, proseFontSize: 16 } });
	const plannerFile = path.join(dir, "planner-appearance.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Đổi màu nhấn.", shouldApplyChanges: true, settingsOperations: [{ section: "appearance", patchJson: '{"colors":{"accent":"#abcdef"}}' }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Đổi màu nhấn", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal?.changes.settings);
	const applied = confirmPlannerCoachProposal(result.proposal.id);
	assert.equal(readSettings()?.appearance?.colors?.surface, "#112233");
	assert.equal(readSettings()?.appearance?.colors?.accent, "#abcdef");
	assert.equal(readSettings()?.appearance?.proseFontSize, 16);
	assert.equal(undoPlannerCoachChangeServer({ plannerFile, now, date, messageId: applied.assistantMessage.id }).undone, true);
	assert.equal(readSettings()?.appearance?.colors?.accent, "#445566");
});

it("provides graph concepts and clearly labeled tentative recall results to Coach", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { chatWithPlannerCoachServer, readPlannerSnapshot } = await import("../src/server/planner.ts");
	const node = { id: "test_context_node", name: "Matrix concept", statement: "A test proposition", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [] };
	stores.graphStore.appendNode(node);
	fs.writeFileSync(path.join(dir, "recall-scan.json"), JSON.stringify({ version: 1, status: "complete", total: 1, results: [{ id: "result", sessionTitle: "Matrix", topic: "Matrix", verdict: "partial", draft: { question: "Matrix question" }, missing: "One condition", correction: "Include it" }] }));
	const plannerFile = path.join(dir, "planner-context.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16", chatsDir = path.join(dir, "chats");
	readPlannerSnapshot({ plannerFile, now, date, chatsDir });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Đây là gợi ý.", shouldApplyChanges: false } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	let prompt = "";
	await chatWithPlannerCoachServer({ plannerFile, now, date, chatsDir, message: "Review Matrix", engineOverride: { model: faux.getModel(), streamFn: (model, context, options) => { prompt = JSON.stringify(context); return faux.streamSimple(model, context, options); } } });
	assert.match(prompt, /test_context_node/);
	assert.match(prompt, /Matrix question/);
	assert.match(prompt, /not confirmed mistakes/);
});

it("does not apply any part of a mixed proposal when one resource changed", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { readSettings, writeSettings } = await import("../src/store/settings.ts");
	const { chatWithPlannerCoachServer, confirmPlannerCoachProposal, readPlannerSnapshot } = await import("../src/server/planner.ts");
	const chat = stores.chatStore.createChat("Mixed original");
	const node = { id: "test_mixed_node", name: "Original node", statement: "Statement", aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [] };
	stores.graphStore.appendNode(node);
	writeSettings({ version: 1, general: { autoUpdate: true } });
	const plannerFile = path.join(dir, "planner-mixed.json"), now = new Date(2026, 10, 16, 12).getTime(), date = "2026-11-16";
	readPlannerSnapshot({ plannerFile, now, date });
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses([fauxAssistantMessage([fauxToolCall("submit_coach_response", { reply: "Đề xuất thay đổi.", shouldApplyChanges: true, sessionOperations: [{ id: chat.id, title: "Changed session" }], graphNodeOperations: [{ id: node.id, name: "Changed node" }], settingsOperations: [{ section: "general", patchJson: '{"autoUpdate":false}' }] } as ToolCall["arguments"], { id: "tc" })], { stopReason: "toolUse" })]);
	const result = await chatWithPlannerCoachServer({ plannerFile, now, date, requireConfirmation: true, message: "Đổi phiên, khái niệm và cài đặt", engineOverride: { model: faux.getModel(), streamFn: faux.streamSimple } });
	assert.ok(result.proposal?.changes.sessions && result.proposal.changes.graph && result.proposal.changes.settings);
	writeSettings({ version: 1, general: { autoUpdate: true }, claudeCode: { enabled: true } });
	assert.throws(() => confirmPlannerCoachProposal(result.proposal!.id), /settings changed/i);
	assert.equal(stores.chatStore.getChat(chat.id)?.title, "Mixed original");
	assert.equal(stores.graphStore.readNodes().find((item) => item.id === node.id)?.name, "Original node");
	assert.equal(readSettings()?.general?.autoUpdate, true);
});

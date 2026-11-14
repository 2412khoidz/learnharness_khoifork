import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-pricing-transport-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const { GET } = await import("../app/api/chats/[id]/route.ts");
const { sessionCost } = await import("../src/server/pricing.ts");
const { stripToolResultImages } = await import("../src/core/native-messages.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("chat GET supplies derived Pi costs without persisting dollars or changing native history", async () => {
	const record = chatStore.createChat("price projection fixture");
	chatStore.saveMessages(record.id, [{ id: "fixture-input", role: "user", content: "synthetic", timestamp: 1 }]);
	const step = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 70_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 500 };
	for (const [id, model] of [["api", "openrouter:openai/gpt-6.1-sol"], ["plan", "chatgpt:fixture"], ["unknown", "missing:fixture"]]) {
		chatStore.appendTurnUsage(record.id, { id: id!, model: model!, messageId: "fixture-input", at: "fixture", steps: [step] });
	}
	const file = path.join(scratch, "chats", `${record.id}.json`);
	const before = fs.readFileSync(file, "utf8");
	const response = await GET(new Request(`http://localhost/api/chats/${record.id}`), { params: Promise.resolve({ id: record.id }) });
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.messages, chatStore.getChat(record.id)!.messages);
	assert.deepEqual(body.pricing, sessionCost(chatStore.getChat(record.id)!));
	assert.equal(body.pricing.cost, 0.037);
	assert.equal(body.pricing.subscription, 1);
	assert.equal(body.pricing.unpriced, 1);
	assert.deepEqual(body.pricing.turnCosts, { api: 0.037, plan: null, unknown: null });
	assert.equal(fs.readFileSync(file, "utf8"), before, "read-time estimates must never rewrite the usage log");
});

test("metadata-only chat reads equal the matching fields of the full read", async () => {
	const record = chatStore.createChat("metadata-only fixture");
	chatStore.saveMessages(record.id, [{ id: "meta-input", role: "user", content: "synthetic", timestamp: 1 }]);
	chatStore.saveSettings(record.id, { model: { provider: "fixture", id: "model" }, thinkingLevel: "low" });
	chatStore.appendTurnUsage(record.id, { id: "api", model: "openrouter:openai/gpt-6.1-sol", messageId: "meta-input", at: "fixture", steps: [{ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0 }] });
	const read = async (query: string) => (await GET(new Request(`http://localhost/api/chats/${record.id}${query}`), { params: Promise.resolve({ id: record.id }) })).json();
	const full = await read("");
	assert.deepEqual(await read("?only=stats"), { turns: full.turns, pricing: full.pricing });
	assert.deepEqual(await read("?only=coverage"), { coverage: full.coverage });
	assert.deepEqual(await read("?only=settings"), { settings: full.settings });
	assert.ok(Array.isArray(full.turns) && full.turns.length === 1, "fixture carries usage");
});

test("client transport strips toolResult image bytes without altering stored history or user images", async () => {
	const record = chatStore.createChat("image transport fixture");
	chatStore.saveMessages(record.id, [
		{ id: "u1", role: "user", content: [{ type: "image", mimeType: "image/jpeg", data: "USER_IMAGE_PAYLOAD" }], timestamp: 1 },
		{
			id: "a1", role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 2,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "img.png" } }],
		},
		{
			id: "r1", role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, timestamp: 3,
			content: [{ type: "image", mimeType: "image/png", data: "RAW_BASE64_PAYLOAD" }, { type: "text", text: "caption" }],
		},
	]);
	const response = await GET(new Request(`http://localhost/api/chats/${record.id}`), { params: Promise.resolve({ id: record.id }) });
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.deepEqual(body.messages[0].content, [{ type: "image", mimeType: "image/jpeg", data: "USER_IMAGE_PAYLOAD" }]);
	assert.deepEqual(body.messages[2].content, [{ type: "image", mimeType: "image/png", data: "" }, { type: "text", text: "caption" }]);
	const stored = chatStore.getChat(record.id)!;
	assert.equal((stored.messages[2] as { content: Array<{ data?: string }> }).content[0]!.data, "RAW_BASE64_PAYLOAD");
	const unchanged = stored.messages.slice(0, 1);
	assert.equal(stripToolResultImages(unchanged), unchanged);
});

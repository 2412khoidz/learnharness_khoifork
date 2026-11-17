import assert from "node:assert/strict";
import { it } from "node:test";
import { GoogleGenAI } from "@google/genai";

// Synthetic SSE only: the SDK previously rejected both cases at EOF.
it("accepts only a complete terminal event without a delimiter and rejects cut or nonterminal events", async () => {
	const original = globalThis.fetch;
	const event = JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "synthetic" }] }, finishReason: "STOP" }] });
	try {
		for (const [tail, valid] of [[`data: ${event}`, true], [`data: ${event}\n\n`, true], [`data: ${event.slice(0, -8)}`, false], [`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "synthetic" }] } }] })}`, false], [`data: ${event.replace('"STOP"', '"MAX_TOKENS"')}`, false]] as const) {
			globalThis.fetch = async () => new Response(tail, { status: 200, headers: { "content-type": "text/event-stream" } });
			const client = new GoogleGenAI({ apiKey: "synthetic-test-key" });
			const stream = await client.models.generateContentStream({ model: "gemini-synthetic", contents: "Synthetic question" });
			const consume = async () => { let count = 0; for await (const _part of stream) count++; return count; };
			if (valid) assert.equal(await consume(), 1);
			else await assert.rejects(consume, /Incomplete JSON segment at the end/);
		}
	} finally { globalThis.fetch = original; }
});

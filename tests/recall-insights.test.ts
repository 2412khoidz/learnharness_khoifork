import assert from "node:assert/strict";
import { it } from "node:test";
import { summarizeRecallObservations, type RecallObservation } from "../src/core/recall-insights.ts";
import { buildAnswer, type QuestionData } from "../src/core/question-core.ts";
import { messageIdFromHash, recallAnswerAnchorId, recallAnswerHref } from "../src/core/session-navigation.ts";

it("keeps provisional partial, uncertain and corrected recall separate and gates trends", () => {
	const now = new Date(2026, 10, 17, 12).getTime();
	const observation = (id: string, daysAgo: number, verdict: RecallObservation["verdict"], source: RecallObservation["source"] = "ai"): RecallObservation => {
		const day = new Date(now); day.setDate(day.getDate() - daysAgo);
		return { id, chatId: "chat", subject: "Math", answeredAt: day.toISOString(), verdict, source, topic: "Limits", errorType: "gap" };
	};
	const items = [observation("a", 1, "partial"), observation("b", 2, "wrong", "user"), observation("c", 1, "uncertain"), observation("d", 3, "correct"), observation("e", 3, "dont_know"), observation("old", 40, "correct")];
	items[0]!.elapsedMs = 4 * 3600_000; items[0]!.timerMs = 120_000; items[0]!.help = "assisted";
	const first = summarizeRecallObservations(items, now);
	assert.equal(first.last30.responses, 5); assert.equal(first.last30.assessed, 5);
	assert.equal(first.last30.partial, 1); assert.equal(first.last30.uncertain, 1); assert.equal(first.last30.ai, 4); assert.equal(first.last30.confirmed, 1);
	assert.equal(first.last30.medianElapsedMin, 240); assert.equal(first.last30.elapsedOver3h, 1); assert.equal(first.last30.medianTimerMin, 2); assert.equal(first.last30.assisted, 1);
	assert.equal(first.trend, null); assert.equal(first.patterns[0]?.count, 3);
	const previous = [observation("p1", 35, "correct"), observation("p2", 35, "correct"), observation("p3", 36, "partial"), observation("p4", 36, "wrong")];
	const current = [observation("c2", 2, "correct")];
	const compared = summarizeRecallObservations([...items, ...previous, ...current], now);
	assert.ok(compared.trend); assert.equal(compared.allTime.responses, 11); assert.equal(compared.allTimePatterns[0]?.count, 5);
});

it("links a recall example to its exact question in the original session", () => {
	const link = new URL(recallAnswerHref("chat/1", "msg 3", "call:7"), "http://localhost");
	assert.equal(link.pathname, "/chat/chat%2F1");
	assert.equal(messageIdFromHash(link.hash), "msg 3");
	assert.equal(link.searchParams.get("recallAnswer"), "call:7");
	assert.equal(recallAnswerAnchorId("msg 3", "call:7"), "recall-msg%203-call%3A7");
	assert.equal(recallAnswerHref("chat/1"), "/chat/chat%2F1");
});

it("only records valid recall timing and help on explain answers", () => {
	const question: QuestionData = { id: "q", kind: "explain", question: "Why?", mode: "text", options: [], createdAt: new Date().toISOString() };
	const result = buildAnswer(question, { text: "Because", recallTiming: { timerMs: 12345 }, recallHelp: "assisted" }, "recall");
	assert.deepEqual(result.recallTiming, { timerMs: 12345 }); assert.equal(result.recallHelp, "assisted");
	assert.equal(buildAnswer(question, { recallTiming: { timerMs: -1 } }).recallTiming, undefined);
	assert.equal(buildAnswer({ ...question, kind: "quiz" }, { recallTiming: { timerMs: 1000 }, recallHelp: "assisted" }).recallTiming, undefined);
});

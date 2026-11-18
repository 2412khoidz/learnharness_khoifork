import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RecallAnalysis } from "../components/recall-analysis.tsx";
import { summarizeRecallObservations } from "../src/core/recall-insights.ts";
import type { LearningCapacityReport } from "../src/core/learning-capacity.ts";

it("shows independent recall, previews exact inputs and requires approval before saving groups", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
	const observations = ["1", "2"].map((id) => ({ id, chatId: "fake-chat", toolCallId: id, subject: "Math", answeredAt: "2026-11-16T12:00:00Z", verdict: "partial" as const, source: "ai" as const, topic: "Limits" }));
	const report = { dataCoverage: { recallAnswers: 2, recallAssigned: 2, recallUnassigned: 0 }, subjectBreakdown: [{ subject: "Math", recallInsights: summarizeRecallObservations(observations, Date.parse("2026-11-17T12:00:00Z")), approvedRecallGroups: { last30: [], allTime: [] } }] } as unknown as LearningCapacityReport;
	const items = observations.map((item) => ({ ...item, fingerprint: `v${item.id}`, errorType: "gap", feedback: "Synthetic feedback" }));
	const preview = { subject: "Math", totalAnswers: 2, totalEligible: 2, limit: 300, offset: 0, model: "fake:model", availableRoles: [], items, allItems: items, groups: [], draft: null, approvedRevision: "revision" };
	const previousFetch = globalThis.fetch;
	let requests = 0, approvals = 0;
	let jobs: unknown[] = [];
	const savedProgress = new Map<string, { sequence: number; value: unknown }>();
	globalThis.fetch = async (input, init) => {
		if (String(input).includes("recall-progress")) {
			if (init?.method === "POST") { const body = JSON.parse(String(init.body)); savedProgress.set(body.key, { sequence: body.sequence, value: body.value }); return new Response(JSON.stringify({ saved: true })); }
			const key = new URL(String(input), "http://localhost").searchParams.get("key") ?? "";
			return new Response(JSON.stringify({ progress: savedProgress.get(key) ?? null }));
		}
		if (String(input).includes("recall-groups?jobs=1")) return new Response(JSON.stringify({ jobs }));
		if (init?.method !== "POST") return new Response(JSON.stringify(preview));
		const body = JSON.parse(String(init.body));
		if (body.action === "start_job") { requests++; assert.deepEqual(body.expected.map((item: { id: string }) => item.id), ["1", "2"]); jobs = [{ id: "job", subject: "Math", model: "fake:model", createdAt: "2026-01-01T00:00:00Z", status: "complete", items, completed: ["1", "2"], skipped: [], usage: { calls: 1, input: 1, output: 1 }, groups: [{ id: "g", name: "Limits", reason: "Related", model: "fake:model", members: items.map(({ id, fingerprint }) => ({ id, fingerprint })) }] }]; return new Response(JSON.stringify({ id: "job" })); }
		approvals++; return new Response(JSON.stringify({ saved: 1 }));
	};
	let root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => root.render(<RecallAnalysis report={report} onRefresh={async () => {}} />));
		assert.match(document.body.textContent ?? "", /Recall Analysis/); assert.equal(requests, 0);
		const review = [...document.querySelectorAll("button")].find((button) => button.textContent === "Review AI grouping input");
		await act(async () => review?.click());
		assert.match(document.body.textContent ?? "", /Synthetic feedback/); assert.match(document.body.textContent ?? "", /fake:model/); assert.equal(requests, 0);
		const suggest = [...document.querySelectorAll("button")].find((button) => button.textContent === "Send preview and suggest groups");
		await act(async () => suggest?.click());
		assert.equal(requests, 1); assert.equal(approvals, 0);
		const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save approved groups");
		assert.ok(save?.disabled, "a proposal is not approved automatically");
		await act(async () => root.unmount());
		assert.ok(savedProgress.has("group:Math"), "pending review progress is flushed when leaving");
		root = createRoot(document.querySelector("main")!);
		await act(async () => root.render(<RecallAnalysis report={report} onRefresh={async () => {}} />));
		const reopen = [...document.querySelectorAll("button")].find((button) => button.textContent === "Review AI grouping input");
		await act(async () => reopen?.click());
		assert.match(document.body.textContent ?? "", /Related/, "the previous proposal is restored even without browser storage");
		assert.equal(requests, 1, "restoring progress never calls the model again");
	} finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

it("opens an approved group answer inline and preserves the exact chat link", async () => {
 const dom = parseHTML("<html><head></head><body><main></main></body></html>");
 const storage = new Map<string, string>();
 Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, Event: dom.window.Event, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, IS_REACT_ACT_ENVIRONMENT: true });
 const obs = Array.from({ length: 4 }, (_, i) => ({ id: `chat:call${i}`, chatId: "chat", toolCallId: `call${i}`, subject: "Math", answeredAt: "2026-11-16T12:00:00Z", verdict: "correct" as const, source: "ai" as const, topic: "Synthetic" }));
 const group = { id: "g", name: "Topic", reason: "Related", model: "fake", stale: false, count: 4, distribution: { correct: 4, partial: 0, wrong: 0, dont_know: 0, uncertain: 0 }, answers: obs.map((item, i) => ({ id: item.id, chatId: item.chatId, toolCallId: item.toolCallId, sourceMessageId: `message${i}` })) };
 const report = { dataCoverage: { recallAnswers: 4, recallAssigned: 4, recallUnassigned: 0 }, subjectBreakdown: [{ subject: "Math", recallInsights: summarizeRecallObservations(obs, Date.parse("2026-11-17T12:00:00Z")), approvedRecallGroups: { last30: [group], allTime: [group] } }] } as unknown as LearningCapacityReport;
 const previousFetch = globalThis.fetch;
 globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("answerId=")) return new Response(JSON.stringify({ answer: { id: "chat:call3", verdict: "correct", missing: "", draft: { id: "chat:call3", chatId: "chat", question: "Question", yourAnswer: "Answer", correctAnswer: "Reference" } }, mistake: { status: "failed" } }));
  if (url.includes("recall-audit")) return new Response(JSON.stringify({ runs: [] }));
  return new Response(JSON.stringify({ progress: null }));
 };
 let root = createRoot(document.querySelector("main")!);
 try {
  await act(async () => root.render(<RecallAnalysis report={report} onRefresh={async () => {}} />));
  const answer = [...document.querySelectorAll("button")].find((button) => button.textContent === "Answer 4"); assert.ok(answer);
  await act(async () => answer.click());
  const dialog = document.querySelector('[aria-label="Answer details"]'); assert.ok(dialog);
  assert.match(dialog.textContent ?? "", /not a correctness verdict/);
  const fullChat = [...dialog.querySelectorAll("a")].find((a) => a.textContent === "Open full chat");
  assert.ok(fullChat?.getAttribute("href")?.includes("recallAnswer=call3")); assert.ok(fullChat?.getAttribute("href")?.includes("message-message3"));
  await act(async () => [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Back to review")?.click());
  assert.equal(document.querySelector('[aria-label="Answer details"]'), null);
  await act(async () => answer.click());
  const chatLink = [...document.querySelectorAll("a")].find((item) => item.textContent === "Open full chat");
  assert.ok(chatLink);
  await act(async () => chatLink.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })));
  assert.equal(JSON.parse(storage.get("lh:recall-return-state")!).answer.id, "chat:call3");
  await act(async () => root.unmount());
  root = createRoot(document.querySelector("main")!);
  await act(async () => root.render(<RecallAnalysis report={report} onRefresh={async () => {}} section="groups" />));
  const returnedLink = [...document.querySelectorAll('[aria-label="Answer details"] a')].find((item) => item.textContent === "Open full chat");
  assert.ok(returnedLink?.getAttribute("href")?.includes("recallAnswer=call3"));
  assert.ok(returnedLink?.getAttribute("href")?.includes("message-message3"));
 } finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

it("restores the review page and keeps split selection separate for overlapping topics", async () => {
 const dom = parseHTML("<html><head></head><body><main></main></body></html>");
 const session = new Map<string, string>([["lh:recall-return-subject", "Math"], ["lh:recall-return-state", JSON.stringify({ reviewOpen: true, groupPage: 1 })]]);
 const local = new Map<string, string>();
 const store = (map: Map<string, string>) => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => map.set(key, value), removeItem: (key: string) => map.delete(key) });
 Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, Event: dom.window.Event, sessionStorage: store(session), localStorage: store(local), IS_REACT_ACT_ENVIRONMENT: true });
 const obs = ["1", "2", "3"].map((id) => ({ id, chatId: "chat", toolCallId: id, subject: "Math", answeredAt: "2026-11-16T12:00:00Z", verdict: "correct" as const, source: "ai" as const, topic: `Answer ${id}` }));
 const items = obs.map((item) => ({ ...item, fingerprint: `v${item.id}`, errorType: "", feedback: "" }));
 const groups = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, name: `Topic ${i}`, reason: "Related", model: "fake", members: items.map(({ id, fingerprint }) => ({ id, fingerprint })) }));
 local.set("lh:recall-review:Math", JSON.stringify({ groups, approved: {}, splitSelection: { [JSON.stringify(["g10", "1"])]: true }, revision: "revision", sequence: 1 }));
 const report = { dataCoverage: { recallAnswers: 3, recallAssigned: 3, recallUnassigned: 0 }, subjectBreakdown: [{ subject: "Math", recallInsights: summarizeRecallObservations(obs, Date.parse("2026-11-17T12:00:00Z")), approvedRecallGroups: { last30: [], allTime: [] } }] } as unknown as LearningCapacityReport;
 const preview = { subject: "Math", totalAnswers: 3, totalEligible: 3, limit: 300, offset: 0, model: "fake", availableRoles: [], items, allItems: items, groups: [], draft: null, approvedRevision: "revision" };
 const previousFetch = globalThis.fetch;
 globalThis.fetch = async (input) => {
  if (String(input).includes("recall-groups?subject=")) return new Response(JSON.stringify(preview));
  if (String(input).includes("recall-groups?jobs=")) return new Response(JSON.stringify({ jobs: [] }));
  if (String(input).includes("recall-audit")) return new Response(JSON.stringify({ runs: [] }));
  return new Response(JSON.stringify({ progress: null, saved: true }));
 };
 const root = createRoot(document.querySelector("main")!);
 try {
  await act(async () => root.render(<RecallAnalysis report={report} onRefresh={async () => {}} />));
  const first = [...document.querySelectorAll("input")].find((input) => input.value === "Topic 10");
  const second = [...document.querySelectorAll("input")].find((input) => input.value === "Topic 11");
  assert.ok(first && second, "the previously viewed page is restored");
  const firstGroup = first.closest("div.space-y-2")!, secondGroup = second.closest("div.space-y-2")!;
  assert.equal(firstGroup.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.checked, true);
  assert.equal(secondGroup.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]?.checked, false);
 } finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

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
	globalThis.fetch = async (_input, init) => {
		if (init?.method !== "POST") return new Response(JSON.stringify(preview));
		const body = JSON.parse(String(init.body));
		if (body.action === "suggest") { requests++; assert.deepEqual(body.expected.map((item: { id: string }) => item.id), ["1", "2"]); return new Response(JSON.stringify({ model: "fake:model", groups: [{ id: "g", name: "Limits", reason: "Related", model: "fake:model", members: items.map(({ id, fingerprint }) => ({ id, fingerprint })) }] })); }
		approvals++; return new Response(JSON.stringify({ saved: 1 }));
	};
	const root = createRoot(document.querySelector("main")!);
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
	} finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

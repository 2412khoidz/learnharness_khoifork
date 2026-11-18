import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { PlannerCapacityModal } from "../components/planner-capacity-modal.tsx";
import { computeLearningCapacityReport } from "../src/core/learning-capacity.ts";
import { DEFAULT_PLANNER_CONFIG, type PlannerPersonalSignals } from "../src/core/planner.ts";

it("opens Overview first and preserves a paged audit preview while a large background audit is running", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
	const date = "2026-11-18";
	const signals: PlannerPersonalSignals = {
		date, examPrep: { subjects: [] } as unknown as PlannerPersonalSignals["examPrep"], subjectSignals: [],
		recentSessions: [], habitTrend: { loggedDays: 0, avgEnergy: null, latestBedtime: null, avgStudyMin: 0 },
	};
	const now = new Date(2026, 10, 18, 12);
	const items = Array.from({ length: 578 }, (_, i) => ({
		draft: { id: `item${i}`, chatId: "chat", question: `Synthetic question ${i}.`, yourAnswer: "Answer", correctAnswer: "Reference" },
		feedback: "Feedback", sessionTitle: "Math", fingerprint: `f${i}`, originalVerdict: "correct", originalSource: "ai", mistake: null,
	}));
	const report = computeLearningCapacityReport({
		config: DEFAULT_PLANNER_CONFIG, signals, now: +now,
		recallObservationsBySubject: { math: items.map(({ draft }) => ({
			id: draft.id, chatId: "chat", subject: "Math", answeredAt: new Date(+now - 1000).toISOString(),
			verdict: "correct", help: "unknown", source: "ai",
		})) },
	});
	const run = {
		id: "running-audit", createdAt: now.toISOString(), model: "fake", status: "running", total: 578, resultCount: 360,
		results: [], usage: { calls: 36, input: 1, output: 1 }, reviews: [],
	};
	const previousFetch = globalThis.fetch;
	let auditReads = 0;
	const writes: string[] = [];
	globalThis.fetch = async (input, init) => {
		const url = String(input);
		if (init?.method === "POST") {
			const { action } = JSON.parse(String(init.body));
			writes.push(action);
			if (action === "preview_diagnosis") return Response.json({ revision: "exact", modelLabel: "fake", systemPrompt: "Explain", estimateUsd: null });
			if (action === "diagnose_ai") return Response.json({ report, diagnosis: { summary: "Synthetic diagnosis", modelLabel: "fake", strengths: [], bottlenecks: [], neuroProtocols: [], suggestedPaceNote: "Practice" } });
			throw new Error("Unexpected write");
		}
		if (url.includes("activity=1")) return Response.json({ audit: [{ done: 360, total: 578 }], groups: [] });
		if (url.includes("recall-audit")) {
			auditReads++;
			return Response.json(url.includes("preview=1") ? { items, count: items.length, roles: [], model: "fake" } : { runs: [run], roles: [] });
		}
		if (url.includes("recall-progress")) return Response.json({ progress: null });
		return Response.json({ report, aiAvailability: { coach: { available: true, modelLabel: "fake" } } });
	};
	const root = createRoot(document.querySelector("main")!);
	const body = () => document.body.textContent ?? "";
	const click = async (name: string) => {
		const button = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
		assert.ok(button, name);
		await act(async () => button.click());
	};
	try {
		await act(async () => root.render(<PlannerCapacityModal open onClose={() => {}} date={date} selectedRole=""
			onChangeRole={() => {}} onSnapshotUpdated={async () => {}} onAskCoachWithReport={() => {}} />));
		assert.match(body(), /6 Scientific Dimensions of Learning Capacity/);
		assert.match(body(), /Per-Subject Calibration Breakdown/);
		assert.match(body(), /Audit 360\/578/);
		assert.equal(auditReads, 0);
		assert.deepEqual(writes, []);
		await click("Audit");
		await click("Preview a new audit");
		const details = [...document.querySelectorAll("details")].find((element) => element.querySelector("summary")?.textContent?.includes("answers and feedback"));
		assert.ok(details);
		await act(async () => { details.open = true; details.dispatchEvent(new dom.window.Event("toggle")); });
		await click("Next answers");
		assert.match(body(), /Synthetic question 10\./);
		assert.doesNotMatch(body(), /Synthetic question 20\./);
		await click("Overview");
		assert.ok(details.closest("[hidden]"));
		await click("Recall");
		await click("Topic groups");
		await click("Audit");
		assert.equal(details.closest("[hidden]"), null);
		assert.match(body(), /Synthetic question 10\./);
		assert.deepEqual(writes, []);
		await click("AI Deep Diagnosis");
		assert.ok(document.querySelector('[aria-label="AI diagnosis preview"]'));
		assert.deepEqual(writes, ["preview_diagnosis"]);
		await click("Send and diagnose");
		assert.deepEqual(writes, ["preview_diagnosis", "diagnose_ai"]);
		assert.match(body(), /Synthetic diagnosis/);
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = previousFetch;
	}
});

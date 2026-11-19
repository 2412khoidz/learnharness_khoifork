import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RecallScanPanel } from "../components/recall-scan-panel.tsx";

it("shows assessments for review and never preselects anything to save", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	const oldFetch = globalThis.fetch;
	const item = (id: string, verdict: string) => ({ id, verdict, sessionTitle: "Math", draft: { id, question: "Explain $x^2$", yourAnswer: "A partial answer" }, strengths: "Good idea", missing: "Missing condition", correction: "Add condition", evidence: "Answer" });
	globalThis.fetch = async () => Response.json({ version: 1, status: "complete", total: 2, results: [item("c:1", "partial"), item("c:2", "correct")], usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, modelCalls: 1 } });
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => { root.render(<RecallScanPanel records={[]} onSaved={() => {}} />); });
		assert.equal(document.querySelectorAll("details").length, 2);
		assert.ok(document.querySelector("summary .katex"), "recall questions render math in their summaries");
		assert.ok(document.body.textContent?.includes("Partly correct"));
		assert.ok(document.body.textContent?.includes("Correct"));
		assert.ok(document.body.textContent?.includes("100 input"));
		const selection = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
		assert.ok(selection);
		assert.equal(selection.checked, false);
		assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 1, "correct answer cannot be saved as a mistake");
		const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Save selected"));
		assert.equal(save?.disabled, true);
		assert.ok([...document.querySelectorAll("button")].some((b) => b.textContent === "Check for new answers"), "completed scan does not show Resume scan");
		assert.equal([...document.querySelectorAll("button")].some((b) => b.textContent === "Resume scan"), false);
	} finally { await act(async () => root.unmount()); globalThis.fetch = oldFetch; }
});

it("supports direct page jump and displays newest assessed recall answers first", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(dom.document, "oninput", { value: null, configurable: true });
	const oldFetch = globalThis.fetch;
	const results = Array.from({ length: 45 }, (_, i) => ({
		id: `c:${i + 1}`,
		verdict: "partial",
		sessionTitle: "Math",
		draft: { id: `c:${i + 1}`, question: `Recall Q #${i + 1}`, yourAnswer: "Partial", answeredAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString() },
		strengths: "ok", missing: "gap", correction: "fix", evidence: "ans",
	}));
	globalThis.fetch = async () => Response.json({ version: 1, status: "paused", total: 60, results });
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => { root.render(<RecallScanPanel records={[]} onSaved={() => {}} />); });
		assert.ok([...document.querySelectorAll("button")].some((b) => b.textContent === "Resume scan"));
		assert.match(document.body.textContent ?? "", /Recall Q #45(?!\d)/, "newest recall answer appears on page 1");
		assert.doesNotMatch(document.body.textContent ?? "", /Recall Q #1(?!\d)/);
		assert.ok(document.body.textContent?.includes("1 / 3"));
		const jumpInput = document.querySelector<HTMLInputElement>('input[aria-label="Jump to page"]')!;
		await act(async () => {
			jumpInput.value = "3";
			(jumpInput as HTMLInputElement & { _valueTracker?: { setValue: (v: string) => void } })._valueTracker?.setValue("1");
			jumpInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			jumpInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		await act(async () => { [...document.querySelectorAll("button")].find((b) => b.textContent === "Go")?.click(); });
		assert.ok(document.body.textContent?.includes("3 / 3"));
		assert.match(document.body.textContent ?? "", /Recall Q #1(?!\d)/);
	} finally { await act(async () => root.unmount()); globalThis.fetch = oldFetch; }
});

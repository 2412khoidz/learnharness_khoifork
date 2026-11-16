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
	} finally { await act(async () => root.unmount()); globalThis.fetch = oldFetch; }
});

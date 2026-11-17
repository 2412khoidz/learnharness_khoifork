import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { PlannerCoachChat } from "../components/planner-coach-chat.tsx";

it("hides proposal details until review and requires a separate confirmation", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	let decision: boolean | null = null;
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => root.render(<PlannerCoachChat messages={[]} focusArea="general" onChangeFocusArea={() => {}} coachAvailable coachModelLabel="test" selectedRole="" onChangeRole={() => {}} sending={false} draftText="" onDraftChange={() => {}} onSend={async () => true} onUndo={async () => {}} onClear={async () => {}} onClose={() => {}} proposal={{ id: "proposal", summary: "Private example", changes: { logs: { before: "old", after: "new" } } }} onProposalDecision={async (apply) => { decision = apply; }} />));
		assert.ok(!document.body.textContent?.includes("Private example"));
		assert.equal([...document.querySelectorAll("button")].some((b) => b.textContent === "Confirm and apply"), false);
		const review = [...document.querySelectorAll("button")].find((b) => b.textContent === "Review changes");
		assert.ok(review); await act(async () => review.click());
		assert.ok(document.body.textContent?.includes("Private example"));
		const confirm = [...document.querySelectorAll("button")].find((b) => b.textContent === "Confirm and apply");
		assert.ok(confirm); assert.equal(decision, null); await act(async () => confirm.click());
		assert.equal(decision, true);
	} finally { await act(async () => root.unmount()); }
});

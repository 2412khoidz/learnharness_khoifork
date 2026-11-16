import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

it("preserves an exam draft after a failed save and validates a cleared title", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(dom.document, "oninput", { value: null, configurable: true });
	const { createRoot } = await import("react-dom/client");
	const { PlannerExamTimetable } = await import("../components/planner-exam-timetable.tsx");
	let calls = 0;
	const root = createRoot(document.querySelector("main")!);
	const setInput = async (input: HTMLInputElement, value: string) => {
		await act(async () => {
			input.value = value;
			(input as HTMLInputElement & { _valueTracker?: { setValue: (previous: string) => void } })._valueTracker?.setValue("previous");
			input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
	};
	try {
		await act(async () => root.render(<PlannerExamTimetable entries={[]} busy={false} onSave={async () => { calls++; return false; }} />));
		const title = document.querySelector("input") as HTMLInputElement;
		const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Thêm lịch thi")!;
		await setInput(title, "Đại số");
		await act(async () => button.click());
		assert.equal(calls, 1);
		assert.equal(title.value, "Đại số", "a failed save leaves the draft editable");
		await setInput(title, "");
		await act(async () => button.click());
		assert.equal(calls, 1, "empty titles are not submitted");
		assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /nhập tên/i);
	} finally {
		await act(async () => root.unmount());
	}
});

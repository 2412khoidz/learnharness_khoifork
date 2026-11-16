import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

it("sends a natural language timetable edit to Coach rather than treating it as a new import", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(dom.document, "oninput", { value: null, configurable: true });
	const { createRoot } = await import("react-dom/client");
	const { WeeklyTkbTab } = await import("../components/planner-page.tsx");
	let requested = "";
	let imported: unknown[] | undefined;
	const originalFetch = globalThis.fetch;
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => root.render(<WeeklyTkbTab
			snap={{ config: { fixedEvents: [] } } as never}
			busy={false}
			coachBusy={false}
			onAskCoach={async (message) => { requested = message; }}
			onSaveFixedEvents={async (events) => { imported = events; }}
			onError={(message) => { throw new Error(message); }}
		/>));
		const textarea = document.querySelector("textarea")!;
		await act(async () => {
			textarea.value = "Sửa ca 1 sáng thành 07:00-09:40";
			(textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker?.setValue("");
			textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			textarea.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Import or edit with AI"));
		assert.ok(button);
		await act(async () => button.click());
		assert.match(requested, /thời khóa biểu tuần/i);
		assert.match(requested, /07:00-09:40/);
		assert.equal(imported, undefined, "existing events must not be appended as newly extracted entries");

		const event = { id: "new", dayOfWeek: "wed", startTime: "07:00", endTime: "09:40", title: "Math", category: "class" };
		let requestedUrl = "";
		globalThis.fetch = (async (url) => {
			requestedUrl = String(url);
			return { ok: true, json: async () => ({ events: [event] }) } as Response;
		}) as typeof fetch;
		const parse = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("Parse Text"));
		assert.ok(parse);
		await act(async () => parse.click());
		assert.equal(requestedUrl, "/api/planner/parse-schedule");
		assert.deepEqual(imported, [event], "explicit local parsing still imports extracted events");
	} finally {
		globalThis.fetch = originalFetch;
		await act(async () => root.unmount());
	}
});

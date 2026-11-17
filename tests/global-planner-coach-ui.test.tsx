import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { GlobalPlannerCoach } from "../components/global-planner-coach.tsx";

it("keeps the Coach close control below window chrome and closes on Escape", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ config: { coachChat: [] }, plan: { date: "2026-11-16" }, aiAvailability: { coach: { available: true, modelLabel: "test" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
	let closes = 0;
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => { root.render(<GlobalPlannerCoach onClose={() => { closes++; }} />); });
		const panel = document.querySelector('[aria-label="Coach"]');
		assert.ok(panel);
		assert.ok(panel?.className.includes("top-14"));
		assert.ok(panel?.className.includes("lh-no-drag"));
		const closeWindow = document.querySelector('[aria-label="Close Coach window"]') as HTMLButtonElement | null;
		assert.ok(closeWindow, "window controls remain visible even while Coach loads");
		const handle = closeWindow.parentElement as HTMLDivElement;
		Object.defineProperty(handle, "setPointerCapture", { value: () => {} });
		Object.defineProperty(panel, "getBoundingClientRect", { value: () => ({ left: 500, right: 920, top: 60, bottom: 760 }) });
		Object.defineProperty(panel.parentElement!, "getBoundingClientRect", { value: () => ({ left: 0, right: 1000, top: 0, bottom: 900 }) });
		const pointer = (type: string, x: number, y: number) => { const event = new dom.window.Event(type, { bubbles: true }); for (const [key, value] of Object.entries({ button: 0, pointerId: 1, clientX: x, clientY: y })) Object.defineProperty(event, key, { value }); return event; };
		await act(async () => { handle.dispatchEvent(pointer("pointerdown", 600, 80)); handle.dispatchEvent(pointer("pointermove", 400, 130)); });
		assert.ok((panel as HTMLElement).style.transform.includes("-200px"), "drag moves the floating panel");
		const close = document.querySelector('[aria-label="Close Coach"]') as HTMLButtonElement | null;
		assert.ok(close);
		await act(async () => close.click());
		assert.equal(closes, 1);
		const escape = new dom.window.Event("keydown");
		Object.defineProperty(escape, "key", { value: "Escape" });
		await act(async () => dom.window.dispatchEvent(escape));
		assert.equal(closes, 2);
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = previousFetch;
	}
});

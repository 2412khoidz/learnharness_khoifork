import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useRecallTimer } from "../components/use-recall-timer.ts";

it("supports pausing and manual correction, and marks a restarted timer interrupted", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	const storage = new Map<string, string>();
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
	const originalNow = Date.now; let now = new Date(2026, 10, 16, 23, 59).getTime(); Date.now = () => now;
	function View() {
		const timer = useRecallTimer("chat:q", true);
		return <div><button onClick={timer.pause}>Pause</button><button onClick={() => timer.adjust(2.5)}>Adjust</button><button onClick={() => timer.setHelp("assisted")}>Help</button><output>{JSON.stringify(timer.snapshot())}</output></div>;
	}
	let root = createRoot(document.querySelector("main")!);
	await act(async () => root.render(<View />));
	const button = (name: string) => [...document.querySelectorAll("button")].find((entry) => entry.textContent === name)!;
	now += 120000;
	await act(async () => button("Pause").click());
	assert.equal(JSON.parse(document.querySelector("output")!.textContent!).recallTiming.timerMs, 120000, "timer spans midnight");
	await act(async () => { button("Adjust").click(); button("Help").click(); });
	const snapshot = JSON.parse(document.querySelector("output")!.textContent!);
	assert.equal(snapshot.recallTiming.timerMs, 150000); assert.equal(snapshot.recallHelp, "assisted");
	await act(async () => root.unmount());
	const key = "lh.recall-timer.chat:q"; const stored = JSON.parse(storage.get(key)!); stored.runId = "previous-run"; storage.set(key, JSON.stringify(stored));
	root = createRoot(document.querySelector("main")!);
	await act(async () => root.render(<View />));
	const restarted = JSON.parse(document.querySelector("output")!.textContent!);
	assert.equal(restarted.recallTiming.timerMs, 150000); assert.equal(restarted.recallTiming.interrupted, true);
	await act(async () => root.unmount());
	Date.now = originalNow;
});

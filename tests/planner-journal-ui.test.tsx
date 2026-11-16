import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { JournalAuditTab } from "../components/planner-page.tsx";

it("keeps journal entries accessible and hides all journal text when the screen is hidden", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(dom.window, "localStorage", { value: { getItem: () => "0", setItem: () => {} }, configurable: true });
	const date = "2026-11-16";
	const title = "A long journal entry with a complete ending that must remain readable";
	const parsed = { id: "parsed", startTime: "09:00", endTime: "10:00", category: "study", subject: "A very long subject name", title, minutes: 60, source: "parsed_text" };
	let snapshot = {
		plan: { date, quotas: [], plannedStudyHours: 1 },
		config: { logs: { [date]: { journalText: "Private history preview", actualEntries: [parsed] } }, plans: {}, realismFactor: 1 },
		aiAvailability: { coach: { available: true }, availableRoles: [] },
	};
	let saved: Record<string, unknown> | undefined;
	const root = createRoot(document.querySelector("main")!);
	const render = () => <JournalAuditTab snap={snapshot as never} busy={false} onCheckIn={async (payload) => { saved = payload; }} onSnapshotUpdate={() => {}} onError={() => {}} />;
	try {
		await act(async () => root.render(render()));
		const details = document.querySelector("details");
		assert.ok(details, "journal entry renders as expandable details");
		assert.ok(details.querySelector("summary"), "native summary is keyboard-accessible");
		assert.ok(details.textContent?.includes(title));
		assert.ok(details.textContent?.includes(parsed.subject));
		assert.ok(document.body.textContent?.includes("Private history preview"), "non-discreet history has a preview");

		const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
		await act(async () => button("Add").click());
		assert.equal(document.querySelectorAll("details").length, 2, "unsaved manual entry appears alongside saved parsed entries");
		await act(async () => button("Save Draft Only").click());
		const entries = saved?.actualEntries as Array<typeof parsed>;
		assert.equal(entries.length, 2);
		assert.equal(entries.filter((entry) => entry.source === "manual").length, 1);
		snapshot = { ...snapshot, config: { ...snapshot.config, logs: { [date]: { journalText: "Private history preview", actualEntries: entries } } } };
		await act(async () => root.render(render()));
		assert.equal(document.querySelectorAll("details").length, 2, "saved manual entries are not duplicated after reload");

		await act(async () => button("Blur screen").click());
		assert.equal(document.querySelector("textarea"), null);
		assert.equal(document.querySelector("details"), null);
		assert.equal(document.body.textContent?.includes(title), false);
		assert.equal(document.body.textContent?.includes("Private history preview"), false, "blur also hides history previews when discreet mode is off");
		assert.equal(button("Show text").getAttribute("aria-pressed"), "true");
		await act(async () => button("Show text").click());
		assert.equal(document.querySelectorAll("details").length, 2);
	} finally {
		await act(async () => root.unmount());
	}
});

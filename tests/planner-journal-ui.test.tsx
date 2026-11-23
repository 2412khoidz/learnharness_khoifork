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

it("auto-formats freeform journal in place on AI Auditor submit and restores original text on Undo", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	const storage = new Map<string, string>();
	Object.assign(globalThis, {
		React,
		window: dom.window,
		document: dom.document,
		Element: dom.window.Element,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.defineProperty(dom.window, "localStorage", {
		value: {
			getItem: (k: string) => storage.get(k) ?? null,
			setItem: (k: string, v: string) => storage.set(k, String(v)),
		},
		configurable: true,
	});

	const date = "2026-11-23";
	const rawText = "hôm nay dậy từ 8h, 17h học biểu diễn tri thức đến 17h45";
	const formattedText = "08:00 : Dậy\n17:00 - 17:45 : Học Biểu diễn tri thức";
	const initialSnap = {
		plan: { date, quotas: [], plannedStudyHours: 2 },
		config: { logs: { [date]: { journalText: rawText, actualEntries: [] } }, plans: {}, realismFactor: 1 },
		aiAvailability: { coach: { available: true, modelLabel: "gpt-6.1-terra" }, availableRoles: [] },
	};

	const origFetch = globalThis.fetch;
	let sentBody: Record<string, unknown> | undefined;
	const checkIns: Array<Record<string, unknown>> = [];
	const root = createRoot(document.querySelector("main")!);

	function Harness() {
		const [snap, setSnap] = React.useState(initialSnap);
		return (
			<JournalAuditTab
				snap={snap as never}
				busy={false}
				onCheckIn={async (payload) => {
					checkIns.push(payload);
					setSnap((prev) => ({
						...prev,
						config: {
							...prev.config,
							logs: {
								...prev.config.logs,
								[date]: {
									...prev.config.logs[date],
									journalText: typeof payload.journalText === "string" ? payload.journalText : prev.config.logs[date]?.journalText ?? "",
								},
							},
						},
					}));
				}}
				onSnapshotUpdate={(next) => setSnap(next as never)}
				onError={() => {}}
			/>
		);
	}

	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		const url = String(_input);
		if (url.includes("/api/stt/token") || url.includes("/api/settings")) {
			return new Response(JSON.stringify({ message: "Keyless in test" }), { status: 503, headers: { "Content-Type": "application/json" } });
		}
		if (url.includes("/api/planner/evaluate-day")) {
			sentBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			const updatedSnap = {
				...initialSnap,
				config: {
					...initialSnap.config,
					logs: {
						[date]: {
							journalText: formattedText,
							actualEntries: [
								{ id: "jai_1", startTime: "17:00", endTime: "17:45", category: "study", subject: "Biểu diễn tri thức", title: "Học Biểu diễn tri thức", minutes: 45, source: "ai_extracted" },
							],
						},
					},
				},
			};
			return new Response(
				JSON.stringify({ snapshot: updatedSnap, formattedJournalApplied: true }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;

	try {
		await act(async () => root.render(<Harness />));
		const buttonByText = (text: string) =>
			[...document.querySelectorAll("button")].find((b) => b.textContent?.includes(text))!;

		await act(async () => buttonByText("AI Auditor").click());
		const toggle = document.querySelector('[data-testid="journal-auto-format-toggle"]') as HTMLInputElement | null;
		assert.ok(toggle, "auto-format toggle appears in AI Auditor mode");
		assert.equal(toggle.checked, true, "auto-format defaults to enabled");

		await act(async () => buttonByText("Save & Score Plan vs Actual (AI)").click());
		assert.equal(sentBody?.mode, "llm");
		assert.equal(sentBody?.formatJournal, true);

		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		assert.equal(textarea.value, formattedText, "editor updates in place with clean HH:MM - HH:MM : ... lines");

		const restoreBtn = document.querySelector('[data-testid="journal-restore-raw"]') as HTMLButtonElement | null;
		assert.ok(restoreBtn, "1-click Restore original text button appears after auto-formatting");
		await act(async () => restoreBtn.click());

		assert.equal((document.querySelector("textarea") as HTMLTextAreaElement).value, rawText, "textarea reverts to original blob");
		assert.equal(document.querySelector('[data-testid="journal-restore-raw"]'), null, "restore button hides after reverting");
		assert.equal(checkIns.at(-1)?.journalText, rawText, "reverted raw journal persists via check-in");
	} finally {
		globalThis.fetch = origFetch;
		await act(async () => root.unmount());
	}
});

it("supports Auto-fill Draft, Copy elapsed plan, Quick Switcher 1-tap chip, Restore Undo, and Dictate button", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	const storage = new Map<string, string>();
	Object.assign(globalThis, {
		React,
		window: dom.window,
		document: dom.document,
		Element: dom.window.Element,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	Object.defineProperty(dom.window, "localStorage", {
		value: {
			getItem: (k: string) => storage.get(k) ?? null,
			setItem: (k: string, v: string) => storage.set(k, String(v)),
		},
		configurable: true,
	});

	const origFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ message: "Keyless in test" }), { status: 503, headers: { "Content-Type": "application/json" } })) as typeof fetch;

	const date = "2026-11-16";
	const snap = {
		plan: {
			date,
			quotas: [{ subject: "Đại số", targetMin: 60 }],
			plannedStudyHours: 1,
			blocks: [
				{ id: "b1", date, startTime: "08:00", endTime: "08:50", startMin: 480, endMin: 530, durationMin: 50, type: "study", title: "Đại số buổi sáng", subject: "Đại số" },
			],
		},
		signals: {
			autoDraftItems: [
				{ startTime: "08:05", category: "sleep", label: "Thức dậy", source: "wake" },
				{ startTime: "09:00", endTime: "09:45", category: "study", subject: "Đại số", label: "Học Đại số", source: "session" },
			],
		},
		config: {
			milestones: [{ id: "m1", subject: "Đại số", title: "OLP", kind: "exam", dueDate: "2026-11-28", priority: 3, cognitiveLoad: "heavy", clusterIds: [], estimatedHours: 10, completedHours: 0, syllabusTopics: [], notes: "" }],
			logs: { [date]: { journalText: "", actualEntries: [] } },
			plans: {},
			realismFactor: 1,
		},
		aiAvailability: { coach: { available: true, modelLabel: "gpt-6.1-terra" }, availableRoles: [] },
	};

	const checkIns: Array<Record<string, unknown>> = [];
	const root = createRoot(document.querySelector("main")!);

	try {
		await act(async () =>
			root.render(
				<JournalAuditTab
					snap={snap as never}
					busy={false}
					onCheckIn={async (payload) => {
						checkIns.push(payload);
					}}
					onSnapshotUpdate={() => {}}
					onError={() => {}}
				/>,
			),
		);

		assert.ok(document.querySelector('[data-testid="journal-dictate-toggle"]'), "Dictate toggle renders in Journal toolbar");
		const chip = [...document.querySelectorAll('[data-testid="journal-switcher-chip"]')].find((el) => el.textContent?.includes("Đại số")) as HTMLButtonElement | undefined;
		assert.ok(chip, "Quick Switcher renders subject chip");
		await act(async () => chip.click());
		assert.deepEqual(checkIns.at(-1), {
			date,
			switchActivity: { label: "Đại số", category: "study", subject: "Đại số" },
		});

		const autoDraftBtn = document.querySelector('[data-testid="journal-autofill-draft"]') as HTMLButtonElement | null;
		assert.ok(autoDraftBtn);
		assert.ok(autoDraftBtn.textContent?.includes("Auto-fill Draft (2)"));
		await act(async () => autoDraftBtn.click());
		const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
		assert.equal(textarea.value, "08:05 : Thức dậy\n09:00 - 09:45 : Học Đại số");

		const copyPlanBtn = document.querySelector('[data-testid="journal-copy-plan"]') as HTMLButtonElement | null;
		assert.ok(copyPlanBtn);
		await act(async () => copyPlanBtn.click());
		assert.ok(textarea.value.includes("08:00 - 08:50 : Đại số buổi sáng"));

		const restoreBtn = document.querySelector('[data-testid="journal-restore-raw"]') as HTMLButtonElement | null;
		assert.ok(restoreBtn, "Restore Undo appears after quick-filling");
		await act(async () => restoreBtn.click());
		assert.ok(typeof checkIns.at(-1)?.journalText === "string");
	} finally {
		globalThis.fetch = origFetch;
		await act(async () => root.unmount());
	}
});

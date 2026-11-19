import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RecallFsrsReview } from "../components/recall-fsrs-review.tsx";

it("requires a concept, a batch review, and an explicit confirmation before saving", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
	const previousFetch = globalThis.fetch;
	let posts = 0;
	const responseData = { nodes: [{ id: "node", name: "Rank", statement: "A matrix concept", reviewedFlashcard: false, revision: "node-revision" }], results: [{ id: "answer", verdict: "partial", sessionTitle: "Algebra", suggestedNodeIds: ["node"], applied: false, revision: "answer-revision", draft: { question: "Explain rank", yourAnswer: "Some work", answeredAt: "2026-01-01T09:00:00.000Z" } }], lastBatch: null };
	globalThis.fetch = async (_input, init) => {
		if (init?.method === "POST") { posts++; return new Response(JSON.stringify({ added: 1 }), { status: 200 }); }
		return new Response(JSON.stringify(responseData), { status: 200 });
	};
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => { root.render(<RecallFsrsReview />); });
		const select = document.querySelector('select[aria-label="Concept"]') as HTMLSelectElement;
		assert.ok(select);
		const review = [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Review batch"));
		assert.ok(review?.disabled);
		// linkedom's select does not expose the browser's writable value setter.
		await act(async () => { Object.defineProperty(select, "value", { configurable: true, value: "node" }); select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
		assert.equal(posts, 0);
		assert.equal(review?.disabled, false);
		await act(async () => review?.click());
		assert.equal(posts, 0);
		const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "Confirm and save");
		assert.ok(confirm);
		await act(async () => confirm.click());
		assert.equal(posts, 1);
	} finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

it("shows analyst suggestions and discussion without saving FSRS", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
	const previousFetch = globalThis.fetch;
	const data = { nodes: [{ id: "rank", name: "Định lý hạng", statement: "Matrix rank original description", reviewedFlashcard: false, revision: "r" }], results: [{ id: "chat:a", verdict: "partial", sessionTitle: "Algebra", suggestedNodeIds: [], applied: false, revision: "a", aiSuggestion: null as { answerId: string; nodeId: string; reason: string; model: string } | null, draft: { question: "Explain rank", yourAnswer: "Part", answeredAt: "2026-01-01T09:00:00.000Z" } }], lastBatch: null };
	let suggestions = 0, fsrsSaves = 0;
	globalThis.fetch = async (_input, init) => {
		if (init?.method !== "POST") return new Response(JSON.stringify(data));
		const body = JSON.parse(String(init.body));
		if (body.action === "suggest") { suggestions++; data.results[0]!.aiSuggestion = { answerId: "chat:a", nodeId: "rank", reason: "Vì câu hỏi về hạng.", model: "analyst" }; return new Response(JSON.stringify({ items: [data.results[0]!.aiSuggestion] })); }
		fsrsSaves++; return new Response(JSON.stringify({ added: 1 }));
	};
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => root.render(<RecallFsrsReview />));
		const suggest = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Suggest concepts with AI"));
		await act(async () => suggest?.click());
		assert.equal(suggestions, 1); assert.equal(fsrsSaves, 0);
		assert.match(document.body.textContent ?? "", /Vì câu hỏi về hạng/);
		assert.match(document.body.textContent ?? "", /Review batch \(1\)/);
		const option = document.querySelector('select[aria-label="Concept"] option[value="rank"]');
		assert.ok(option, "the actual suggested ID is in the dropdown even without a lexical match");
		assert.match(option.textContent ?? "", /AI suggestion/);
		assert.match(document.body.textContent ?? "", /Matrix rank original description/);
	} finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

it("supports direct page jump when recall FSRS candidates span multiple pages", async () => {
	const dom = parseHTML("<html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(dom.document, "oninput", { value: null, configurable: true });
	const previousFetch = globalThis.fetch;
	const results = Array.from({ length: 25 }, (_, i) => ({
		id: `chat:a${i + 1}`, verdict: "partial", sessionTitle: "Algebra", suggestedNodeIds: [], applied: false, revision: `r${i}`,
		draft: { question: `FSRS Question #${i + 1}`, yourAnswer: "Part", answeredAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() },
	}));
	globalThis.fetch = async () => new Response(JSON.stringify({ nodes: [], results, lastBatch: null, availableRoles: [] }));
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => root.render(<RecallFsrsReview />));
		assert.match(document.body.textContent ?? "", /FSRS Question #25(?!\d)/, "newest item on page 1");
		assert.ok(document.body.textContent?.includes("1 / 2"));
		const jumpInput = document.querySelector<HTMLInputElement>('input[aria-label="Jump to page"]')!;
		await act(async () => {
			jumpInput.value = "2";
			(jumpInput as HTMLInputElement & { _valueTracker?: { setValue: (v: string) => void } })._valueTracker?.setValue("1");
			jumpInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			jumpInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		await act(async () => { [...document.querySelectorAll("button")].find((b) => b.textContent === "Go")?.click(); });
		assert.ok(document.body.textContent?.includes("2 / 2"));
		assert.match(document.body.textContent ?? "", /FSRS Question #1(?!\d)/);
	} finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

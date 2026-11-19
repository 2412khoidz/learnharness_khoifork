/**
 * The Mistakes page card renders MODEL-AUTHORED Markdown through
 * ToolContentResponse. These pins exist because the old plain-text spans
 * showed raw TeX ("$25\,^\circ\text{C}$") instead of KaTeX.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { MistakeCard, MistakesPage } from "../components/mistakes-page.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { presentMistakeAnalysis, type MistakeRecord } from "../src/core/mistakes.ts";

const record: MistakeRecord = {
	id: "chat_1:call_1",
	chatId: "chat_1",
	kind: "missed",
	origin: "quiz",
	question: "A copper coil at $20\\,^\\circ\\text{C}$ draws $3\\,\\text{A}$. Find $R$.",
	yourAnswer: "$66.9\\,^\\circ\\text{C}$",
	correctAnswer: "$70.9\\,^\\circ\\text{C}$",
	thinking: "Use $R_2 = R_1(1 + \\alpha \\Delta t)$.",
	answeredAt: "2026-11-10T10:00:00.000Z",
	createdAt: "2026-11-10T10:00:00.000Z",
	sessionTitle: "FEEX - Unit 1",
	sessionKind: "teach",
	sources: [],
	status: "ready",
	analysis: {
		errorType: "setup-error",
		topic: "temperature coefficient of resistance",
		whatYouDid: "You used $\\alpha_0$ with a resistance at $20\\,^\\circ\\text{C}$.",
		correct: "Move the coefficient first: $\\alpha_{20} = \\alpha_0/(1+\\alpha_0 t_1)$.",
		rule: "Check the reference temperature before substituting $\\alpha$.",
	},
};

function render(open: boolean) {
	return renderToStaticMarkup(
		<MistakeCard record={record} open={open} onToggle={() => {}} onDelete={() => {}} onRetry={() => {}} />,
	);
}

describe("Mistakes analysis code tokens", () => {
	it("turns regex-as-math into inline code without touching real math", () => {
		const input = String.raw`It is not knowing that $\backslash$d means a digit, $[.-]$ is a class, and $\{3\}$ is three. Real math $[1,4,9,16]$ and $\alpha_0$ stay. Code $r"\backslash d\{3\}[.-]\backslash d\{4\}"$ too.`;
		const out = presentMistakeAnalysis(input);
		assert.match(out, /`\\d` means a digit/);
		assert.match(out, /`\[\.-\]` is a class/);
		assert.match(out, /`\{3\}` is three/);
		assert.match(out, /\$\[1,4,9,16\]\$/);
		assert.match(out, /\$\\alpha_0\$/);
		assert.match(out, /`r"\\d\{3\}\[\.-\]\\d\{4\}"`/);
		assert.match(presentMistakeAnalysis("covers $123-456-7890$ and $987.654.3210$"), /`123-456-7890` and `987\.654\.3210`/);
	});
});

describe("Mistakes card Markdown and math", () => {
	it("renders the question as KaTeX, never as raw dollar-TeX", () => {
		const html = render(false);
		assert.match(html, /data-testid="mistake-card"/);
		assert.match(html, /class="katex"/);
		assert.doesNotMatch(html, /\$20\\,/, "the question's TeX is rendered, not printed");
	});

	it("expanded card renders answers, analysis, and the rule as Markdown/KaTeX", () => {
		const html = render(true);
		assert.match(html, /data-testid="mistake-card-body"/);
		assert.match(html, /Your answer/);
		assert.match(html, /Correct answer/);
		assert.match(html, /What happened/);
		assert.match(html, /What’s correct/);
		assert.match(html, /Remember this/);
		assert.match(html, /Your reasoning/);
		assert.match(html, /class="katex"/);
		assert.doesNotMatch(html, /\\alpha_0\$/, "the rule's TeX is rendered");
	});
});

describe("MistakesPage tabs, newest-first ordering, and pagination jump", () => {
	it("shows Mistakes newest-first on the default tab, supports jumping pages, and switches to Recall Review tab", async () => {
		const dom = parseHTML("<html><head></head><body><main></main></body></html>");
		Object.assign(globalThis, {
			React,
			self: dom.window,
			window: dom.window,
			document: dom.document,
			Element: dom.window.Element,
			HTMLElement: dom.window.HTMLElement,
			Event: dom.window.Event,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		Object.defineProperty(dom.document, "oninput", { value: null, configurable: true });
		const records: MistakeRecord[] = Array.from({ length: 25 }, (_, i) => ({
			...record,
			id: `c:q${i + 1}`,
			question: `Mistake Question #${i + 1}`,
			answeredAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
			createdAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
		}));
		const oldFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			if (String(input).includes("/api/mistakes/recall-scan")) {
				return Response.json({ version: 1, status: "complete", total: 0, results: [] });
			}
			return Response.json({ mistakes: records, progress: { active: 0, done: 0, total: 0 } });
		}) as typeof fetch;

		const root = createRoot(dom.document.querySelector("main")!);
		try {
			await act(async () => {
				root.render(
					<InteractionLayersProvider>
						<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
							<MistakesPage showTopBar={false} />
						</ServerEventsProvider>
					</InteractionLayersProvider>,
				);
			});
			await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

			// Default tab is Mistakes; RecallScanPanel is separated into the second tab.
			assert.equal(dom.document.body.textContent?.includes("Review past free-recall answers"), false);
			assert.match(dom.document.body.textContent ?? "", /Mistake Question #25(?!\d)/, "newest mistake must be on Page 1");
			assert.doesNotMatch(dom.document.body.textContent ?? "", /Mistake Question #1(?!\d)/, "oldest mistake belongs on Page 2");
			assert.ok(dom.document.body.textContent?.includes("1 / 2"));

			// Jump directly to page 2.
			const jumpInput = dom.document.querySelector<HTMLInputElement>('input[aria-label="Jump to page"]')!;
			assert.ok(jumpInput);
			await act(async () => {
				jumpInput.value = "2";
				(jumpInput as HTMLInputElement & { _valueTracker?: { setValue: (v: string) => void } })._valueTracker?.setValue("1");
				jumpInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
				jumpInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
			});
			const goBtn = [...dom.document.querySelectorAll("button")].find((b) => b.textContent === "Go")!;
			await act(async () => { goBtn.click(); });
			assert.ok(dom.document.body.textContent?.includes("2 / 2"));
			assert.match(dom.document.body.textContent ?? "", /Mistake Question #1(?!\d)/);

			// Switch to Recall Review & FSRS tab.
			const recallTab = dom.document.querySelector<HTMLButtonElement>('[data-testid="mistakes-tab-recall"]')!;
			await act(async () => { recallTab.click(); });
			await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
			assert.ok(dom.document.body.textContent?.includes("Review past free-recall answers"));
		} finally {
			await act(async () => root.unmount());
			globalThis.fetch = oldFetch;
		}
	});
});

import React, { act } from "react";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RecallAudit } from "../components/recall-audit.tsx";

it("renders a large audit preview lazily, ten answers at a time, without model calls", async () => {
 const dom = parseHTML("<html><head></head><body><main></main></body></html>");
 Object.assign(globalThis, { React, window: dom.window, document: dom.document, Element: dom.window.Element, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
 Object.defineProperty(dom.document, "oninput", { value: null, configurable: true });
 const items = Array.from({ length: 578 }, (_, i) => ({ draft: { id: `item${i}`, chatId: "chat", question: `Synthetic question ${i}`, yourAnswer: "Answer", correctAnswer: "Reference" }, feedback: "Feedback", sessionTitle: "Synthetic", fingerprint: `f${i}`, originalVerdict: "correct", originalSource: "ai", mistake: null }));
 const previousFetch = globalThis.fetch; let posts = 0;
 globalThis.fetch = async (input, init) => { if (init?.method === "POST") posts++; return new Response(JSON.stringify(String(input).includes("preview=1") ? { items, count: items.length, roles: [], model: "fake", estimate: "unknown" } : { runs: [], roles: [] })); };
 const root = createRoot(document.querySelector("main")!);
 try {
  await act(async () => root.render(<RecallAudit onApplied={async () => {}} />));
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Preview a new audit")?.click());
  assert.equal(document.body.textContent?.includes("Synthetic question 0"), false, "closed preview does not render every answer");
  const details = document.querySelector("details")!;
  await act(async () => { details.open = true; details.dispatchEvent(new dom.window.Event("toggle")); });
  assert.ok(document.body.textContent?.includes("Synthetic question 0"));
  assert.equal(document.body.textContent?.includes("Synthetic question 10"), false);
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Next answers")?.click());
  assert.ok(document.body.textContent?.includes("Synthetic question 10"));
  assert.equal(document.body.textContent?.includes("Synthetic question 0"), false);
  const jumpInput = document.querySelector<HTMLInputElement>('input[aria-label="Jump to page"]')!;
  await act(async () => {
   jumpInput.value = "30";
   (jumpInput as HTMLInputElement & { _valueTracker?: { setValue: (v: string) => void } })._valueTracker?.setValue("2");
   jumpInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
   jumpInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Go")?.click());
  assert.ok(document.body.textContent?.includes("30 / 58"));
  assert.ok(document.body.textContent?.includes("Synthetic question 290"));
  assert.equal(posts, 0, "viewing preview does not call AI");
 } finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; }
});

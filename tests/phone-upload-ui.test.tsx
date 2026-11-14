import React, { act, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PathInput } from "../components/path-input.tsx";
import { readPathInput, restorePathSelection } from "../components/path-input-dom.ts";
import { PhoneUploadButton } from "../components/phone-upload-button.tsx";
import { Composer } from "../components/composer.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { ATTACHMENT_NOTICE_EVENT } from "../src/core/index.ts";
import { installModalDom } from "./modal-dom.ts";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const originalFetch = globalThis.fetch;
const cleanups: (() => Promise<void> | void)[] = [];

function setupDom() {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	const selection = {
		anchorNode: null as Node | null,
		anchorOffset: 0,
		focusNode: null as Node | null,
		focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(dom.document, { getSelection: () => selection, oninput: null });
	const globals = {
		window: dom.window,
		document: dom.document,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		Event: dom.window.Event,
		KeyboardEvent: dom.window.KeyboardEvent,
	};
	const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	Object.assign(globalThis, globals);
	const restoreModal = installModalDom(dom);
	return {
		dom,
		cleanup() {
			restoreModal();
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		},
	};
}

async function mount(element: React.ReactElement) {
	const env = setupDom();
	const host = env.dom.document.createElement("div") as unknown as HTMLElement;
	env.dom.document.body.append(host);
	const root = createRoot(host);
	const dispose = async () => {
		await act(async () => { root.unmount(); });
		host.remove();
		env.cleanup();
	};
	cleanups.push(dispose);
	await act(async () => {
		root.render(<InteractionLayersProvider>{element}</InteractionLayersProvider>);
	});
	return { dom: env.dom, host, dispose };
}

afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

function InputHarness({ fileInsertion = true, initial = "" }: { fileInsertion?: boolean; initial?: string }) {
	const [value, setValue] = useState(initial);
	const ref = useRef<HTMLDivElement>(null);
	return (
		<div>
			<PathInput ref={ref} value={value} onValueChange={setValue} fileInsertion={fileInsertion} />
			<PhoneUploadButton editorRef={ref} />
		</div>
	);
}

describe("PathInput Ctrl+V clipboard image paste", () => {
	it("uploads pasted image files via /api/attachments and inserts path chips at the caret", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response(JSON.stringify({
				path: "C:\\data\\attachments\\paste-1.png",
				filename: "paste-1.png",
				mimeType: "image/png",
				size: 12,
			}), { status: 200, headers: { "Content-Type": "application/json" } });
		}) as typeof fetch;

		const { dom, host } = await mount(<InputHarness initial="See  now" />);
		const editor = host.querySelector<HTMLDivElement>("[data-file-path-input]")!;
		editor.focus();
		restorePathSelection(editor, { anchor: 4, focus: 4 });
		dom.document.dispatchEvent(new dom.window.Event("selectionchange"));

		const file = new File([PNG_BYTES], "clip.png", { type: "image/png" });
		const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
		Object.assign(paste, {
			clipboardData: {
				getData: () => "",
				items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
				files: [file],
			},
		});

		await act(async () => {
			editor.dispatchEvent(paste);
			await new Promise((r) => setTimeout(r, 25));
		});

		assert.deepEqual(calls, ["/api/attachments"]);
		assert.equal(readPathInput(editor), "See `C:\\data\\attachments\\paste-1.png` now");
	});

	it("prefers text/plain over image when both are present and skips upload when fileInsertion=false", async () => {
		let fetchCount = 0;
		globalThis.fetch = (async () => {
			fetchCount++;
			return new Response("{}", { status: 500 });
		}) as typeof fetch;

		const first = await mount(<InputHarness />);
		const editor = first.host.querySelector<HTMLDivElement>("[role='textbox']")!;
		editor.focus();
		const file = new File([PNG_BYTES], "excel.png", { type: "image/png" });
		const mixedPaste = new first.dom.window.Event("paste", { bubbles: true, cancelable: true });
		Object.assign(mixedPaste, {
			clipboardData: {
				getData: (t: string) => t === "text/plain" ? "copied text" : "",
				files: [file],
			},
		});
		await act(async () => { editor.dispatchEvent(mixedPaste); });
		assert.equal(fetchCount, 0);
		assert.equal(readPathInput(editor), "copied text");
		await first.dispose();

		const disabled = await mount(<InputHarness fileInsertion={false} />);
		const disabledEditor = disabled.host.querySelector<HTMLDivElement>("[role='textbox']")!;
		disabledEditor.focus();
		const imgOnly = new disabled.dom.window.Event("paste", { bubbles: true, cancelable: true });
		Object.assign(imgOnly, { clipboardData: { getData: () => "", files: [file] } });
		await act(async () => { disabledEditor.dispatchEvent(imgOnly); });
		assert.equal(fetchCount, 0);
		assert.equal(readPathInput(disabledEditor), "");
	});

	it("emits ATTACHMENT_NOTICE_EVENT without mutating draft when upload fails", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "Image exceeds 25 MB" }), { status: 413 })
		) as typeof fetch;

		const { dom, host } = await mount(<InputHarness initial="keep draft" />);
		const notices: string[] = [];
		const onNotice = (e: Event) => { notices.push(String((e as CustomEvent).detail)); };
		dom.window.addEventListener(ATTACHMENT_NOTICE_EVENT, onNotice);
		cleanups.push(() => dom.window.removeEventListener(ATTACHMENT_NOTICE_EVENT, onNotice));

		const editor = host.querySelector<HTMLDivElement>("[data-file-path-input]")!;
		const file = new File([PNG_BYTES], "huge.png", { type: "image/png" });
		const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
		Object.assign(paste, { clipboardData: { getData: () => "", files: [file] } });

		await act(async () => {
			editor.dispatchEvent(paste);
			await new Promise((r) => setTimeout(r, 25));
		});
		assert.equal(readPathInput(editor), "keep draft");
		assert.deepEqual(notices, ["Image exceeds 25 MB"]);
	});
});

describe("PhoneUploadButton QR modal and docks", () => {
	it("opens QR dialog, lets user switch IP, inserts received phone photos, and stops server on close", async () => {
		let deletedSession = "";
		let pollCount = 0;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "/api/attachments/phone" && init?.method === "POST") {
				return new Response(JSON.stringify({
					sessionId: "sess-1",
					token: "tok-abc",
					port: 49999,
					defaultAddress: "192.168.1.42",
					addresses: [
						{ address: "192.168.1.42", interfaceName: "Wi-Fi", recommended: true },
						{ address: "10.0.0.9", interfaceName: "Ethernet", recommended: false },
					],
					expiresAt: Date.now() + 60_000,
				}), { status: 200 });
			}
			if (url.startsWith("/api/attachments/phone?sessionId=sess-1") && (!init?.method || init.method === "GET")) {
				pollCount++;
				if (pollCount === 1) {
					return new Response(JSON.stringify({
						active: true,
						expiresAt: Date.now() + 60_000,
						uploads: [{
							index: 0,
							path: "C:\\data\\attachments\\phone-page1.jpg",
							filename: "phone-page1.jpg",
							mimeType: "image/jpeg",
							size: 4200,
							receivedAt: Date.now(),
						}],
						nextIndex: 1,
					}), { status: 200 });
				}
				return new Response(JSON.stringify({ active: true, expiresAt: Date.now() + 60_000, uploads: [], nextIndex: 1 }), { status: 200 });
			}
			if (url.startsWith("/api/attachments/phone?sessionId=sess-1") && init?.method === "DELETE") {
				deletedSession = "sess-1";
				return new Response(JSON.stringify({ closed: true }), { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const { dom, host } = await mount(<InputHarness />);
		const button = host.querySelector<HTMLButtonElement>('[data-testid="phone-upload"]')!;
		const editor = host.querySelector<HTMLDivElement>("[data-file-path-input]")!;

		await act(async () => {
			button.click();
			await new Promise((r) => setTimeout(r, 30));
		});

		const dialog = dom.document.body.querySelector('[data-testid="phone-upload-dialog"]')!;
		assert.ok(dialog, "QR dialog must mount when clicked");
		assert.ok(dialog.querySelector('svg[role="img"]'), "QR SVG must render");
		assert.match(dialog.textContent ?? "", /http:\/\/192\.168\.1\.42:49999\/p\/tok-abc/);

		// Switch LAN IP interface
		const select = dialog.querySelector("select")!;
		await act(async () => {
			select.options[1]!.selected = true;
			select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
		});
		assert.match(dialog.textContent ?? "", /http:\/\/10\.0\.0\.9:49999\/p\/tok-abc/);

		// Wait for poll interval to deliver uploaded photo path
		await act(async () => {
			await new Promise((r) => setTimeout(r, 850));
		});
		assert.match(dialog.querySelector('[data-testid="phone-upload-received"]')?.textContent ?? "", /phone-page1\.jpg/);
		assert.equal(readPathInput(editor), "`C:\\data\\attachments\\phone-page1.jpg`");

		// Close via Done button -> closes server session cleanly
		const doneBtn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent?.includes("Done"))!;
		await act(async () => {
			doneBtn.click();
			await new Promise((r) => setTimeout(r, 30));
		});
		assert.equal(dom.document.body.querySelector('[data-testid="phone-upload-dialog"]'), null);
		assert.equal(deletedSession, "sess-1");
	});

	it("renders PhoneUploadButton inside Composer, QuestionDock, and PracticeDock", async () => {
		const cMount = await mount(
			<Composer busy={false} value="" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend={false} />,
		);
		assert.ok(cMount.host.querySelector('[data-testid="phone-upload"]'));
		await cMount.dispose();

		const qMount = await mount(
			<QuestionDock toolName="ask_user_question" toolCallId="q1" input={{ question: "Show your proof" }} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.ok(qMount.host.querySelector('[data-testid="phone-upload"]'));
		await qMount.dispose();

		const pMount = await mount(
			<PracticeDock problemCallId="p1" input={{ statement: "Prove it" }} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.ok(pMount.host.querySelector('[data-testid="phone-upload"]'));
	});
});

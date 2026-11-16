import React, { act } from "react";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { parseHTML } from "linkedom";

it("shows the reason when Coach cannot safely undo a change", async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-undo-ui-"));
	const oldDataDir = process.env.LH_DATA_DIR;
	process.env.LH_DATA_DIR = dataDir;
	const dom = parseHTML("<!doctype html><html><head></head><body><main></main></body></html>");
	Object.assign(globalThis, { React, window: dom.window, self: dom.window, document: dom.document, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(dom.document, "oninput", { value: null, configurable: true });
	const { createRoot } = await import("react-dom/client");
	const { PlannerPage } = await import("../components/planner-page.tsx");
	const { ServerEventsProvider } = await import("../components/server-events.tsx");
	const { readPlannerSnapshot } = await import("../src/server/planner.ts");
	const snapshot = readPlannerSnapshot({ plannerFile: path.join(dataDir, "planner.json"), chatsDir: path.join(dataDir, "chats") });
	snapshot.config.coachChat = [{ id: "msg-1", role: "assistant", text: "Đã cập nhật", timestamp: new Date().toISOString(), appliedChange: { id: "change-1", summary: "Đã đổi lịch", patchLabels: [] } }];
	snapshot.config.lastCoachUndo = { messageId: "msg-1", date: snapshot.plan.date, hadDayOverride: false, hadLog: false, prevIntensity: snapshot.config.intensity, prevLifestyle: snapshot.config.lifestyle };
	const reason = "Dữ liệu đã được thay đổi sau lượt Coach; không thể hoàn tác an toàn.";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url, init) => {
		const isUndo = String(url) === "/api/planner/coach" && String(init?.body).includes('"undo"');
		return { ok: true, json: async () => isUndo ? { snapshot, undone: false, reason } : snapshot } as Response;
	}) as typeof fetch;
	const root = createRoot(document.querySelector("main")!);
	try {
		await act(async () => root.render(<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}><PlannerPage /></ServerEventsProvider>));
		const toggle = document.querySelector('[data-testid="planner-coach-toggle"]') as HTMLButtonElement;
		assert.ok(toggle);
		await act(async () => toggle.click());
		const undo = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Undo");
		assert.ok(undo);
		await act(async () => undo.click());
		assert.equal(document.querySelector('[role="alert"]')?.textContent?.includes(reason), true);
	} finally {
		await act(async () => root.unmount());
		globalThis.fetch = originalFetch;
		if (oldDataDir === undefined) delete process.env.LH_DATA_DIR;
		else process.env.LH_DATA_DIR = oldDataDir;
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
});

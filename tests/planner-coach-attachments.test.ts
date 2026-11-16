import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-coach-files-"));
process.env.LH_DATA_DIR = temp;
after(() => fs.rmSync(temp, { recursive: true, force: true }));

it("extracts supported documents and stores only validated attachment ids", async () => {
	const { prepareCoachAttachments, readCoachAttachment } = await import("../src/server/coach-attachments.ts");
	const file = new File(["Lịch thi: thứ Tư"], "lịch.txt", { type: "text/plain" });
	const prepared = await prepareCoachAttachments([file]);
	assert.match(prepared.attachmentText, /Lịch thi: thứ Tư/);
	assert.equal(prepared.images.length, 0);
	assert.equal(readCoachAttachment(prepared.attachments[0]!.id), null);
	prepared.save();
	assert.equal(readCoachAttachment(prepared.attachments[0]!.id)?.toString(), "Lịch thi: thứ Tư");
	assert.equal(readCoachAttachment("../../settings.json"), null);
	prepared.cleanup();
	assert.equal(readCoachAttachment(prepared.attachments[0]!.id), null);
	await assert.rejects(() => prepareCoachAttachments([new File(["data"], "run.exe")]), /Unsupported/);
});

it("serves only files present in the Coach conversation as safe downloads", async () => {
	const { prepareCoachAttachments } = await import("../src/server/coach-attachments.ts");
	const { savePlannerConfig, readPlannerConfig } = await import("../src/server/planner.ts");
	const { GET } = await import("../app/api/planner/coach/attachments/[id]/route.ts");
	const prepared = await prepareCoachAttachments([new File(["Private timetable"], "schedule.txt")]);
	prepared.save();
	const item = prepared.attachments[0]!;
	assert.equal((await GET(new Request("http://localhost"), { params: Promise.resolve({ id: item.id }) })).status, 404);
	const config = readPlannerConfig();
	config.coachChat = [{ id: "message", role: "user", text: "[Attachment]", timestamp: new Date().toISOString(), attachments: [item] }];
	savePlannerConfig(config);
	prepared.cleanupIfUnreferenced();
	assert.ok(fs.existsSync(path.join(temp, "coach-attachments", item.id)), "a failure after chat commit must not delete its referenced file");
	const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: item.id }) });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "Private timetable");
	assert.equal(response.headers.get("content-type"), "application/octet-stream");
	assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/);
});

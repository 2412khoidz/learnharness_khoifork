import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";
import { extractPlannerMaterialFile } from "./planner.ts";

export type CoachAttachment = { id: string; name: string; mimeType: string; size: number };
const MAX_TOTAL = 25 * 1024 * 1024;
const directory = () => path.join(PATHS.data, "coach-attachments");
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate and extract before writing, so failed requests never leave partial attachments. */
export async function prepareCoachAttachments(files: File[]): Promise<{ attachments: CoachAttachment[]; images: ImageContent[]; attachmentText: string; save: () => void; cleanup: () => void; cleanupIfUnreferenced: () => void }> {
	if (files.length > 5) throw new Error("Choose at most 5 attachments.");
	if (files.reduce((n, file) => n + file.size, 0) > MAX_TOTAL) throw new Error("Attachments exceed the 25 MB total limit.");
	const pending: Array<{ meta: CoachAttachment; bytes: Buffer }> = [];
	const images: ImageContent[] = [];
	const texts: string[] = [];
	for (const file of files) {
		const name = file.name.replace(/[\\/\x00-\x1f]/g, "_").slice(0, 160);
		const ext = path.extname(name).toLowerCase();
		const imageType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string, string>)[ext];
		const mimeType = imageType ?? ({ ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown" } as Record<string, string>)[ext];
		if (!mimeType) throw new Error(`Unsupported file: ${name}. Use an image, PDF, TXT or Markdown file.`);
		if (!file.size) throw new Error(`${name} is empty.`);
		const bytes = Buffer.from(await file.arrayBuffer());
		if (imageType) images.push({ type: "image", mimeType, data: bytes.toString("base64") });
		else {
			const extracted = await extractPlannerMaterialFile(name, bytes);
			texts.push(`File: ${name}\n${extracted.notice ?? ""}\n${extracted.text}`);
		}
		pending.push({ meta: { id: randomUUID(), name, mimeType, size: bytes.length }, bytes });
	}
	const written: string[] = [];
	const cleanup = () => { for (const dest of written) { try { fs.unlinkSync(dest); } catch { /* best effort */ } } };
	return {
		attachments: pending.map(({ meta }) => meta), images, attachmentText: texts.join("\n\n"),
		save: () => { fs.mkdirSync(directory(), { recursive: true }); for (const item of pending) { const dest = path.join(directory(), item.meta.id); fs.writeFileSync(dest, item.bytes, { flag: "wx", mode: 0o600 }); written.push(dest); } },
		cleanup,
		cleanupIfUnreferenced: () => {
			// A failure after the chat was committed must not remove files it now
			// references. If the state cannot be read, preserve files conservatively.
			try {
				const config = JSON.parse(fs.readFileSync(path.join(PATHS.data, "planner.json"), "utf8")) as { coachChat?: Array<{ attachments?: Array<{ id?: string }> }> };
				const ids = new Set((config.coachChat ?? []).flatMap((message) => (message.attachments ?? []).map((a) => a.id)));
				if (!pending.some(({ meta }) => ids.has(meta.id))) cleanup();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") cleanup();
			}
		},
	};
}

export function readCoachAttachment(id: string): Buffer | null {
	if (!idPattern.test(id)) return null;
	try { return fs.readFileSync(path.join(directory(), id)); } catch { return null; }
}

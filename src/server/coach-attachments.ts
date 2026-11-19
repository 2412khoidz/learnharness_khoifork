import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";

export type CoachAttachment = { id: string; name: string; mimeType: string; size: number };
const MAX_TOTAL = 25 * 1024 * 1024;
const directory = (dataDir = PATHS.data) => path.join(dataDir, "coach-attachments");
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate and extract before writing, so failed requests never leave partial attachments. */
export async function prepareCoachAttachments(files: File[], dataDir = PATHS.data): Promise<{ attachments: CoachAttachment[]; images: ImageContent[]; attachmentText: string; save: () => void; cleanup: () => void; cleanupIfUnreferenced: () => void }> {
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
			const { extractPlannerMaterialFile } = await import("./planner.ts");
			const extracted = await extractPlannerMaterialFile(name, bytes);
			texts.push(`File: ${name}\n${extracted.notice ?? ""}\n${extracted.text}`);
		}
		pending.push({ meta: { id: randomUUID(), name, mimeType, size: bytes.length }, bytes });
	}
	const written: string[] = [];
	const cleanup = () => { for (const dest of written) { try { fs.unlinkSync(dest); } catch { /* best effort */ } } };
	return {
		attachments: pending.map(({ meta }) => meta), images, attachmentText: texts.join("\n\n"),
		save: () => { fs.mkdirSync(directory(dataDir), { recursive: true }); for (const item of pending) { const dest = path.join(directory(dataDir), item.meta.id); fs.writeFileSync(dest, item.bytes, { flag: "wx", mode: 0o600 }); written.push(dest); } },
		cleanup,
		cleanupIfUnreferenced: () => {
			// A failure after the chat was committed must not remove files it now
			// references. If the state cannot be read, preserve files conservatively.
			try {
				const config = JSON.parse(fs.readFileSync(path.join(dataDir, "planner.json"), "utf8")) as { coachChat?: Array<{ attachments?: Array<{ id?: string }> }> };
				const ids = new Set((config.coachChat ?? []).flatMap((message) => (message.attachments ?? []).map((a) => a.id)));
				if (!pending.some(({ meta }) => ids.has(meta.id))) cleanup();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") cleanup();
			}
		},
	};
}

export function readCoachAttachment(id: string, dataDir = PATHS.data): Buffer | null {
	if (!idPattern.test(id)) return null;
	try { return fs.readFileSync(path.join(directory(dataDir), id)); } catch { return null; }
}

/** Re-open the latest saved attachments without creating additional copies. */
export async function loadCoachAttachments(attachments: readonly CoachAttachment[], dataDir = PATHS.data): Promise<{ images: ImageContent[]; attachmentText: string }> {
	const files = attachments.map((attachment) => {
		const bytes = readCoachAttachment(attachment.id, dataDir);
		if (!bytes) throw new Error(`Không thể đọc tệp đã gửi trước đó: ${attachment.name}. Vui lòng đính kèm lại.`);
		return new File([new Uint8Array(bytes)], attachment.name, { type: attachment.mimeType });
	});
	try {
		const prepared = await prepareCoachAttachments(files, dataDir);
		return { images: prepared.images, attachmentText: prepared.attachmentText };
	} catch (error) {
		throw new Error(`Không thể đọc tệp đã gửi trước đó. Vui lòng đính kèm lại. ${error instanceof Error ? error.message : ""}`.trim());
	}
}

/** Delete orphaned UUID files in `coach-attachments/` not referenced by chat history or active proposals. */
export function pruneUnreferencedCoachAttachments(
	dataDir = PATHS.data,
	extraKeepIds: Iterable<string> = [],
): void {
	const dir = directory(dataDir);
	let entries: string[];
	try {
		if (!fs.existsSync(dir)) return;
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	const keep = new Set<string>(extraKeepIds);
	try {
		const plannerPath = path.join(dataDir, "planner.json");
		if (fs.existsSync(plannerPath)) {
			const config = JSON.parse(fs.readFileSync(plannerPath, "utf8")) as {
				coachChat?: Array<{ attachments?: Array<{ id?: string }> }>;
			};
			for (const message of config.coachChat ?? []) {
				for (const item of message.attachments ?? []) {
					if (typeof item.id === "string" && idPattern.test(item.id)) keep.add(item.id);
				}
			}
		}
	} catch {
		// If planner.json cannot be parsed, avoid deleting potentially live attachments.
		return;
	}
	for (const entry of entries) {
		if (!idPattern.test(entry) || keep.has(entry)) continue;
		try {
			fs.unlinkSync(path.join(dir, entry));
		} catch {
			/* best effort */
		}
	}
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { detectSupportedImageMimeType } from "../agent/image-processing/index.ts";
import { readFileAccessSettings } from "../store/settings.ts";
import type { AttachmentUploadResult } from "../core/attachments.ts";

export const MAX_ATTACHMENT_IMAGE_BYTES = 25 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MIME_TO_EXTENSION: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

export class AttachmentError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = "AttachmentError";
		this.status = status;
	}
}

function sniffImageMimeType(bytes: Buffer): string | null {
	const detected = detectSupportedImageMimeType(bytes);
	if (detected) return detected;
	if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
	return null;
}

function formatTimestamp(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function expandHomeFolder(folder: string): string {
	if (folder === "~") return os.homedir();
	if (folder.startsWith("~/")) return path.join(os.homedir(), folder.slice(2));
	return folder;
}

function isWithinFolder(target: string, folder: string): boolean {
	const resolvedTarget = path.resolve(target);
	const resolvedFolder = path.resolve(expandHomeFolder(folder));
	const rel = process.platform === "win32"
		? path.relative(resolvedFolder.toLowerCase(), resolvedTarget.toLowerCase())
		: path.relative(resolvedFolder, resolvedTarget);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function restrictedAttachmentWarning(targetDir: string): string | undefined {
	const result = readFileAccessSettings();
	if (!result.ok) {
		return "File access policy is invalid; the tutor cannot read saved image attachments until it is fixed in Settings.";
	}
	if (!result.settings.restricted) return undefined;
	if (result.settings.folders.some((folder) => isWithinFolder(targetDir, folder))) return undefined;
	return `Restricted file access is enabled in Settings; add ${path.resolve(targetDir)} to allowed folders so the tutor can read saved photos.`;
}

export interface SaveAttachmentOptions {
	prefix?: "paste" | "phone";
	attachmentsDir?: string;
	now?: Date;
}

/** Validate raw image bytes via magic bytes and save into the attachments folder. */
export function saveAttachmentImage(input: Uint8Array, options: SaveAttachmentOptions = {}): AttachmentUploadResult {
	const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
	if (bytes.length === 0) throw new AttachmentError("Empty image payload", 400);
	if (bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) {
		throw new AttachmentError("Image exceeds the 25 MB limit", 413);
	}
	const mimeType = sniffImageMimeType(bytes);
	const ext = mimeType ? MIME_TO_EXTENSION[mimeType] : undefined;
	if (!mimeType || !ext) {
		throw new AttachmentError("Unsupported image format (expected JPEG, PNG, WebP, GIF, or BMP)", 415);
	}
	const dir = options.attachmentsDir ? path.resolve(/* turbopackIgnore: true */ options.attachmentsDir) : PATHS.attachments;
	fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
	const prefix = options.prefix === "phone" ? "phone" : "paste";
	const stamp = formatTimestamp(options.now ?? new Date());
	const id = crypto.randomBytes(4).toString("hex");
	const filename = `${prefix}-${stamp}-${id}.${ext}`;
	const targetPath = path.join(/* turbopackIgnore: true */ dir, filename);
	fs.writeFileSync(/* turbopackIgnore: true */ targetPath, bytes, { flag: "wx" });
	const warning = restrictedAttachmentWarning(dir);
	return {
		path: targetPath,
		filename,
		mimeType,
		size: bytes.length,
		...(warning ? { warning } : {}),
	};
}

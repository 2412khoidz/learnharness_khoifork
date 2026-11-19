import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

export interface BackupSummary {
	nodesCount: number;
	chainsCount: number;
	chatsCount: number;
	flashcardsPropositionsCount: number;
	flashcardsReviewsCount: number;
	mistakesCount: number;
}

export interface KronoHarnessBackupBundle {
	format: "kronoharness-backup-v1";
	createdAt: string;
	summary: BackupSummary;
	files: Record<string, string>;
}

export class BackupError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = "BackupError";
		this.status = status;
	}
}

const ALLOWED_SINGLE_FILES = new Set([
	"exam-prep.json",
	"mistakes.json",
	"mistake-dismissals.json",
	"recall-groups.json",
	"recall-group-jobs.json",
	"recall-audits.json",
	"recall-review-progress.json",
	"recall-scan.json",
	"recall-live-grades.json",
	"recall-overrides.json",
	"recall-fsrs.json",
	"recall-mapping-suggestions.json",
	"planner.json",
	"settings.json",
	"live-models-cache.json",
	"core-plugin-data/flashcards/flashcards.json",
]);

const ALLOWED_DIR_FILE_PATTERNS: ReadonlyArray<RegExp> = [
	/^graph\/[A-Za-z0-9_.-]+\.(json|jsonl)$/,
	/^chats\/[A-Za-z0-9_.-]+\.json$/,
	/^core-plugin-data\/flashcards\/sources\/[A-Za-z0-9_.-]+\.md$/,
	/^coach-attachments\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
];

export function isAllowedBackupRelativePath(relPath: string): boolean {
	if (typeof relPath !== "string" || !relPath || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes("..")) {
		return false;
	}
	if (relPath === "auth.json" || relPath.endsWith("/auth.json")) {
		return false;
	}
	if (ALLOWED_SINGLE_FILES.has(relPath)) return true;
	return ALLOWED_DIR_FILE_PATTERNS.some((re) => re.test(relPath));
}

function resolveSafeDataPath(dataDir: string, relPath: string): string {
	if (!isAllowedBackupRelativePath(relPath)) {
		throw new BackupError(`Unsafe or unsupported backup path: ${relPath}`, 400);
	}
	const root = path.resolve(/* turbopackIgnore: true */ dataDir);
	const resolved = path.resolve(/* turbopackIgnore: true */ root, relPath);
	if (!resolved.startsWith(root + path.sep)) {
		throw new BackupError(`Path escapes data directory: ${relPath}`, 400);
	}
	return resolved;
}

function countNonEmptyLines(text: string | undefined): number {
	if (!text) return 0;
	let count = 0;
	for (const line of text.split(/\r?\n/)) {
		if (line.trim().length > 0) count++;
	}
	return count;
}

export function computeBackupSummary(files: Record<string, string>): BackupSummary {
	const nodesCount = countNonEmptyLines(files["graph/nodes.jsonl"]);
	const chainsCount = countNonEmptyLines(files["graph/chains.jsonl"]);
	let chatsCount = 0;
	for (const key of Object.keys(files)) {
		if (/^chats\/[A-Za-z0-9_.-]+\.json$/.test(key)) chatsCount++;
	}
	let flashcardsPropositionsCount = 0;
	let flashcardsReviewsCount = 0;
	const fcRaw = files["core-plugin-data/flashcards/flashcards.json"];
	if (fcRaw) {
		try {
			const parsed = JSON.parse(fcRaw) as {
				propositions?: Record<string, unknown>;
				reviews?: unknown[];
			};
			if (parsed.propositions && typeof parsed.propositions === "object") {
				flashcardsPropositionsCount = Object.keys(parsed.propositions).length;
			}
			if (Array.isArray(parsed.reviews)) {
				flashcardsReviewsCount = parsed.reviews.length;
			}
		} catch {
			// Leave counts at 0 if unreadable
		}
	}
	let mistakesCount = 0;
	const rawMistakes = files["mistakes.json"];
	if (typeof rawMistakes === "string") {
		try {
			const parsed = JSON.parse(rawMistakes) as unknown;
			if (Array.isArray(parsed)) mistakesCount = parsed.length;
		} catch {
			// Ignore malformed count preview during summary computation
		}
	}

	return {
		nodesCount,
		chainsCount,
		chatsCount,
		flashcardsPropositionsCount,
		flashcardsReviewsCount,
		mistakesCount,
	};
}

function collectAllowedDirFiles(
	dataDir: string,
	subdir: string,
	out: Record<string, string>,
): void {
	const absDir = path.join(/* turbopackIgnore: true */ dataDir, subdir);
	if (!fs.existsSync(absDir)) return;
	for (const entry of fs.readdirSync(/* turbopackIgnore: true */ absDir)) {
		const rel = `${subdir}/${entry}`;
		if (!isAllowedBackupRelativePath(rel)) continue;
		const absFile = path.join(/* turbopackIgnore: true */ absDir, entry);
		try {
			if (fs.statSync(/* turbopackIgnore: true */ absFile).isFile()) {
				out[rel] = subdir === "coach-attachments"
					? `base64:${fs.readFileSync(/* turbopackIgnore: true */ absFile).toString("base64")}`
					: fs.readFileSync(/* turbopackIgnore: true */ absFile, "utf8");
			}
		} catch {
			// Skip unreadable entries
		}
	}
}

/**
 * Export all user learning state (knowledge graph, chat transcripts,
 * FSRS-6 flashcards, exam prep config, general settings, model cache) into
 * a portable snapshot bundle. Never includes `auth.json` or binary caches.
 */
export function exportLearningBackup(dataDir = PATHS.data): KronoHarnessBackupBundle {
	const files: Record<string, string> = {};

	for (const rel of ALLOWED_SINGLE_FILES) {
		const absFile = resolveSafeDataPath(dataDir, rel);
		try {
			if (fs.existsSync(absFile) && fs.statSync(/* turbopackIgnore: true */ absFile).isFile()) {
				files[rel] = fs.readFileSync(/* turbopackIgnore: true */ absFile, "utf8");
			}
		} catch {
			// Skip missing/unreadable optional single files
		}
	}

	collectAllowedDirFiles(dataDir, "graph", files);
	collectAllowedDirFiles(dataDir, "chats", files);
	collectAllowedDirFiles(dataDir, "core-plugin-data/flashcards/sources", files);
	collectAllowedDirFiles(dataDir, "coach-attachments", files);

	return {
		format: "kronoharness-backup-v1",
		createdAt: new Date().toISOString(),
		summary: computeBackupSummary(files),
		files,
	};
}

export function importLearningBackup(
	raw: unknown,
	dataDir = PATHS.data,
): { ok: true; restoredFiles: number; summary: BackupSummary } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new BackupError("Backup payload must be a JSON object", 400);
	}
	const bundle = raw as Record<string, unknown>;
	if (bundle.format !== "kronoharness-backup-v1") {
		throw new BackupError("Unsupported backup format (expected kronoharness-backup-v1)", 400);
	}
	if (!bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) {
		throw new BackupError("Backup payload missing files map", 400);
	}

	const entries = Object.entries(bundle.files as Record<string, unknown>);
	if (entries.length === 0) {
		throw new BackupError("Backup archive contains no files", 400);
	}

	const validated: Array<{ relPath: string; absPath: string; content: string }> = [];
	const validatedFilesMap: Record<string, string> = {};

	for (const [relPath, content] of entries) {
		if (typeof content !== "string") {
			throw new BackupError(`Backup entry must be string content: ${relPath}`, 400);
		}
		const absPath = resolveSafeDataPath(dataDir, relPath);
		validated.push({ relPath, absPath, content });
		validatedFilesMap[relPath] = content;
	}

	for (const item of validated) {
		fs.mkdirSync(path.dirname(item.absPath), { recursive: true });
		const payload: string | Buffer =
			item.relPath.startsWith("coach-attachments/") && item.content.startsWith("base64:")
				? Buffer.from(item.content.slice(7), "base64")
				: item.content;
		writeFileAtomicSync(item.absPath, payload, { allowInPlaceFallback: true });
	}

	return {
		ok: true,
		restoredFiles: validated.length,
		summary: computeBackupSummary(validatedFilesMap),
	};
}

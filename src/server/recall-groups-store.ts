import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { RecallGroup, RecallGroupSource } from "../core/recall-groups.ts";
import { validateRecallGroups } from "../core/recall-groups.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";

interface GroupRecord { subject: string; groups: RecallGroup[]; draft?: RecallGroup[] }
export function readRecallGroups(dir = PATHS.data): GroupRecord[] {
	try {
		const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, "recall-groups.json"), "utf8"));
		if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { subjects?: unknown }).subjects)) throw new Error("Invalid recall group data.");
		return (value as { subjects: GroupRecord[] }).subjects;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function saveRecallGroups(subject: string, groups: RecallGroup[], sources: readonly RecallGroupSource[], dir = PATHS.data): void {
	if (!subject.trim()) throw new Error("Choose a subject.");
	const problem = validateRecallGroups(groups, sources);
	if (problem) throw new Error(problem);
	const previous = readRecallGroups(dir);
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(path.join(dir, "recall-groups.json"), JSON.stringify({ version: 1, subjects: [...previous.filter((row) => row.subject !== subject), { subject, groups }] }), { allowInPlaceFallback: true });
}

/** Drafts stay local and are never included in the report or sent to Coach. */
export function saveRecallGroupDraft(subject: string, draft: RecallGroup[], sources: readonly RecallGroupSource[], dir = PATHS.data): void {
	if (!subject.trim()) throw new Error("Choose a subject.");
	const problem = validateRecallGroups(draft, sources);
	if (problem) throw new Error(problem);
	const previous = readRecallGroups(dir);
	const groups = previous.find((row) => row.subject === subject)?.groups ?? [];
	fs.mkdirSync(dir, { recursive: true });
	writeFileAtomicSync(path.join(dir, "recall-groups.json"), JSON.stringify({ version: 1, subjects: [...previous.filter((row) => row.subject !== subject), { subject, groups, draft }] }), { allowInPlaceFallback: true });
}

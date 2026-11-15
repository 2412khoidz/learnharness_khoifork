import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { MistakeRecord } from "../core/mistakes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

/**
 * The mistake log — `data/mistakes.json`, an array of MistakeRecords.
 * Every quiz miss, "I don't know", or un-solved practice problem lands here
 * once; its background analysis fills in underneath without touching any
 * chat file.
 */

export function mistakesFile(dataDir = PATHS.data): string {
	return path.join(/* turbopackIgnore: true */ dataDir, "mistakes.json");
}

export function readMistakes(file = mistakesFile()): MistakeRecord[] {
	try {
		if (!fs.existsSync(/* turbopackIgnore: true */ file)) return [];
		const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8")) as unknown;
		return Array.isArray(parsed) ? (parsed as MistakeRecord[]) : [];
	} catch {
		return [];
	}
}

export function writeMistakes(records: readonly MistakeRecord[], file = mistakesFile()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, `${JSON.stringify(records, null, "\t")}\n`, { allowInPlaceFallback: true });
	if (file === mistakesFile()) emit("mistakes-changed", {});
}

/** Read-modify-write synchronously under Node's single thread (no awaits inside
 *  `fn`), then announce to listeners so UI views stay in sync. */
export function updateMistakes(
	fn: (current: MistakeRecord[]) => MistakeRecord[],
	file = mistakesFile(),
): MistakeRecord[] {
	const next = fn(readMistakes(file));
	writeMistakes(next, file);
	return next;
}

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	computeGraphFsrsSummary,
	emptyGraphFsrsSummary,
	type FlashcardsStoreSnapshot,
	type GraphFsrsSummary,
} from "../core/fsrs-graph.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import { graphView } from "./graph.ts";

export function defaultFlashcardsStorePath(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "core-plugin-data", "flashcards", "flashcards.json");
}

/** Read Flashcards FSRS-6 state and project it onto the current Knowledge Graph. */
export function readGraphFsrsSummary(
	snapshot: Pick<GraphSnapshot, "nodes" | "chains"> = graphView(),
	flashcardsFile = defaultFlashcardsStorePath(),
	now = Date.now(),
): GraphFsrsSummary {
	let raw: string;
	try {
		raw = fs.readFileSync(flashcardsFile, "utf8");
	} catch {
		return emptyGraphFsrsSummary();
	}
	try {
		const parsed = JSON.parse(raw) as FlashcardsStoreSnapshot;
		return computeGraphFsrsSummary(snapshot, parsed, now);
	} catch {
		return emptyGraphFsrsSummary();
	}
}

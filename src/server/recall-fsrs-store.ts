import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import type { RecallFsrsEvent } from "../core/recall-fsrs.ts";

export const recallFsrsLedgerPath = () => path.join(PATHS.data, "recall-fsrs.json");

export function readRecallFsrsEvents(file = recallFsrsLedgerPath()): RecallFsrsEvent[] {
	let raw: string;
	try { raw = fs.readFileSync(file, "utf8"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const data: unknown = JSON.parse(raw);
	if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1 || !Array.isArray((data as { events?: unknown }).events)) throw new Error("Recall FSRS data is invalid; nothing was changed.");
	const events = (data as { events: RecallFsrsEvent[] }).events;
	if (events.some((e) => !e || typeof e.answerId !== "string" || typeof e.nodeId !== "string" || typeof e.batchId !== "string" || ![1, 2, 3, 4].includes(e.rating) || !Number.isFinite(e.answeredAt) || !Number.isFinite(e.confirmedAt) || (e.revertedAt !== undefined && !Number.isFinite(e.revertedAt)))) throw new Error("Recall FSRS data contains an invalid event; nothing was changed.");
	return events;
}

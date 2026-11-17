import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import { collectRecallCandidates, type MistakeDraft } from "../core/mistakes.ts";
import type { RecallHelp, RecallVerdict } from "../core/recall-insights.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { stores } from "./stores.ts";
import { readRecallFsrsEvents } from "./recall-fsrs-store.ts";

export interface RecallOverride { id: string; fingerprint: string; verdict?: RecallVerdict; help?: RecallHelp; timerMs?: number; updatedAt: string }
export const recallFingerprint = (draft: Pick<MistakeDraft, "id" | "question" | "yourAnswer" | "correctAnswer" | "answeredAt">) => createHash("sha256").update(JSON.stringify([draft.id, draft.question, draft.yourAnswer, draft.correctAnswer, draft.answeredAt])).digest("hex");
export function readRecallOverrides(dir = PATHS.data): RecallOverride[] {
	try {
		const data: unknown = JSON.parse(fs.readFileSync(path.join(dir, "recall-overrides.json"), "utf8"));
		if (!data || typeof data !== "object" || (data as { version?: unknown }).version !== 1 || !Array.isArray((data as { entries?: unknown }).entries)) throw new Error("Invalid recall override data.");
		return (data as { entries: RecallOverride[] }).entries;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function recallOverrideInfo(id: string) {
	const chatId = id.split(":", 1)[0];
	if (!chatId) throw new Error("Invalid answer ID.");
	const chat = stores.chatStore.getChat(chatId);
	const candidate = chat && collectRecallCandidates(chatId, chat.messages).find((item) => item.draft.id === id);
	if (!candidate) throw new Error("Answer is unavailable; refresh and try again.");
	const fingerprint = recallFingerprint(candidate.draft);
	const entry = readRecallOverrides().find((item) => item.id === id && item.fingerprint === fingerprint);
	const reviewed = readRecallFsrsEvents().find((item) => item.answerId === id && !item.revertedAt);
	return { id, fingerprint, entry: entry ?? null, fsrsReview: reviewed ? { rating: reviewed.rating, nodeId: reviewed.nodeId } : null };
}

export function saveRecallOverride(input: { id: string; fingerprint: string; expectedUpdatedAt?: string | null; verdict?: RecallVerdict; help?: RecallHelp; timerMs?: number }) {
	const current = recallOverrideInfo(input.id);
	if (current.fingerprint !== input.fingerprint) throw new Error("The answer changed; refresh before saving.");
	if ((current.entry?.updatedAt ?? null) !== (input.expectedUpdatedAt ?? null)) throw new Error("This correction changed; reload before saving.");
	if (input.verdict !== undefined && !["correct", "partial", "wrong", "dont_know", "uncertain"].includes(input.verdict)) throw new Error("Invalid assessment.");
	if (input.help !== undefined && !["independent", "assisted", "unknown"].includes(input.help)) throw new Error("Invalid assistance value.");
	if (input.timerMs !== undefined && (!Number.isFinite(input.timerMs) || input.timerMs < 0 || input.timerMs > 7 * 86400_000)) throw new Error("Invalid time.");
	const entries = readRecallOverrides();
	const entry: RecallOverride = { ...(current.entry ?? { id: input.id, fingerprint: input.fingerprint }), ...(input.verdict !== undefined ? { verdict: input.verdict } : {}), ...(input.help !== undefined ? { help: input.help } : {}), ...(input.timerMs !== undefined ? { timerMs: input.timerMs } : {}), updatedAt: new Date().toISOString() };
	const next = [...entries.filter((item) => item.id !== input.id), entry];
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomicSync(path.join(PATHS.data, "recall-overrides.json"), JSON.stringify({ version: 1, entries: next }), { allowInPlaceFallback: true });
	return entry;
}

import { collectRecallCandidates, type RecallScanResult } from "../core/mistakes.ts";
import { stores } from "./stores.ts";
import { liveRecallGrades, recallScanStatus } from "./recall-scan.ts";
import { readRecallOverrides, recallFingerprint } from "./recall-overrides.ts";
import { readMistakes } from "../store/mistakes.ts";

/** Read one answer without building the graph/FSRS suggestion table for the whole workspace. */
export function readRecallAnswer(id: string) {
 const separator = id.indexOf(":");
 if (separator < 1) throw new Error("Invalid answer ID.");
 const chatId = id.slice(0, separator), chat = stores.chatStore.getChat(chatId);
 if (!chat) throw new Error("This chat is unavailable.");
 const candidate = collectRecallCandidates(chatId, chat.messages).find((item) => item.draft.id === id);
 if (!candidate) throw new Error("This answer is unavailable.");
 const fingerprint = recallFingerprint(candidate.draft);
 const prior = liveRecallGrades(chatId).find((item) => item.id === id) ?? recallScanStatus().results.find((item) => item.id === id);
 const current = prior && recallFingerprint(prior.draft) === fingerprint ? prior : undefined;
 const override = readRecallOverrides().find((entry) => entry.id === id && entry.fingerprint === fingerprint);
 const fallback: RecallScanResult = { id, draft: candidate.draft, sessionTitle: chat.title, verdict: "uncertain", strengths: "", missing: "", correction: "", evidence: "", errorType: "knowledge-gap", topic: "", rule: "" };
 const answer = { ...(current ?? fallback), draft: candidate.draft, effectiveVerdict: override?.verdict ?? current?.verdict, assessmentSource: override?.verdict ? "user" as const : current ? "ai" as const : "unassessed" as const, assessmentStale: Boolean(prior && !current), tutorFeedback: candidate.feedback };
	const mistake = readMistakes().find((item) => item.id === id);
	const toolCallId = id.slice(separator + 1);
	const sourceMessageId = (chat.messages as Array<{ id?: string; role?: string; content?: unknown }>)
		.find((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b: { type?: string; id?: string }) => b?.type === "toolCall" && b?.id === toolCallId))?.id;
	return { answer, source: { chatId, ...(sourceMessageId ? { sourceMessageId } : {}), toolCallId }, mistake: mistake ? { status: mistake.status } : null };
}

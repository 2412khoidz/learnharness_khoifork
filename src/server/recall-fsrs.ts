import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { PATHS } from "../../config.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import type { PiEngine } from "../agent/models.ts";
import { projectRecallFsrs, type RecallFsrsEvent } from "../core/recall-fsrs.ts";
import { collectRecallCandidates, type RecallScanResult } from "../core/mistakes.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { graphView } from "./graph.ts";
import { liveRecallGrades, recallScanStatus } from "./recall-scan.ts";
import { stores } from "./stores.ts";
import { readRecallFsrsEvents, recallFsrsLedgerPath } from "./recall-fsrs-store.ts";
import { analystEngine } from "./mistake-analysis.ts";

const revisionOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nodeRevision = (node: { id: string; name: string; statement: string }) => revisionOf([node.id, node.name, node.statement]);
const answerRevision = (result: RecallScanResult) => revisionOf([result.id, result.verdict, result.draft, result.strengths, result.missing, result.correction, result.evidence]);

interface MappingSuggestion { answerId: string; answerRevision: string; nodeId: string; nodeRevision: string; reason: string; model: string }
const suggestionsFile = () => path.join(PATHS.data, "recall-mapping-suggestions.json");
function readSuggestions(): MappingSuggestion[] {
	try { const value: unknown = JSON.parse(fs.readFileSync(suggestionsFile(), "utf8")); if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { items?: unknown }).items)) throw new Error("Invalid saved mapping suggestions."); return (value as { items: MappingSuggestion[] }).items; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function assessments(): RecallScanResult[] {
	const all = new Map(recallScanStatus().results.map((result) => [result.id, result]));
	const valid = new Map<string, RecallScanResult["draft"]>();
	for (const chat of stores.chatStore.listChats()) {
		const record = stores.chatStore.getChat(chat.id);
		if (!record) continue;
		for (const candidate of collectRecallCandidates(record.id, record.messages)) valid.set(candidate.draft.id, candidate.draft);
		for (const result of liveRecallGrades(chat.id)) all.set(result.id, result);
	}
	return [...all.values()].filter((result) => {
		const current = valid.get(result.id);
		return current && result.draft && current.chatId === result.draft.chatId && current.question === result.draft.question && current.yourAnswer === result.draft.yourAnswer && current.correctAnswer === result.draft.correctAnswer && current.answeredAt === result.draft.answeredAt;
	});
}

function reviewedFlashcardIds(): Set<string> {
	try {
		const file = path.join(PATHS.data, "core-plugin-data", "flashcards", "flashcards.json");
		const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as { propositions?: Record<string, { schedule?: { reps?: number } }> };
		return new Set(Object.entries(snapshot.propositions ?? {}).filter(([, item]) => (item.schedule?.reps ?? 0) > 0).map(([id]) => id));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
		throw new Error("Flashcards data could not be read; cannot safely approve recall reviews.");
	}
}

/** Suggestions are lexical hints only; the learner explicitly chooses every node. */
export function recallFsrsReviewData() {
	const nodes = graphView().propositions;
	const events = readRecallFsrsEvents().filter((event) => !event.revertedAt);
	const applied = new Set(events.map((event) => event.answerId));
	const lastBatchId = events.at(-1)?.batchId;
	const reviewed = reviewedFlashcardIds();
	const saved = new Map(readSuggestions().map((entry) => [entry.answerId, entry]));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const tokenize = (value: string) => new Set(value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
	return {
		lastBatch: lastBatchId ? { id: lastBatchId, count: events.filter((event) => event.batchId === lastBatchId).length } : null,
		nodes: nodes.map((node) => ({ id: node.id, name: node.name, statement: node.statement, reviewedFlashcard: reviewed.has(node.id), revision: nodeRevision(node) })),
		results: assessments().map((result) => {
			const questionWords = tokenize(`${result.draft.question} ${result.topic}`);
			const suggestedNodeIds = nodes.map((node) => {
				const names = tokenize(node.name); let matches = 0;
				for (const word of names) if (questionWords.has(word)) matches++;
				const sameSession = node.provenance.some((p) => p.chatId === result.draft.chatId);
				return { id: node.id, score: names.size ? matches / names.size + (sameSession && matches ? 0.25 : 0) : 0 };
			}).filter((item) => item.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 4).map((item) => item.id);
			const suggestion = saved.get(result.id), target = suggestion?.nodeId ? byId.get(suggestion.nodeId) : undefined;
			const validSuggestion = suggestion && suggestion.answerRevision === answerRevision(result) && (!suggestion.nodeId || (target && !reviewed.has(target.id) && nodeRevision(target) === suggestion.nodeRevision)) ? suggestion : null;
			return { ...result, revision: answerRevision(result), suggestedNodeIds, applied: applied.has(result.id), aiSuggestion: validSuggestion };
		}),
	};
}

const mappingSchema = Type.Object({ items: Type.Array(Type.Object({ answerId: Type.String(), nodeId: Type.String(), reason: Type.String() })) });
export const recallMappingEngineOverride: { current?: PiEngine } = {};
/** Paid only when explicitly invoked. Suggestions never update FSRS. */
export async function suggestRecallMappings(ids: readonly string[], signal?: AbortSignal, discussion?: { question: string; history: Array<{ role: string; text: string }> }) {
	if (!ids.length || ids.length > 10 || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string")) throw new Error("Choose between 1 and 10 different answers.");
	if (discussion && (ids.length !== 1 || !discussion.question.trim() || discussion.question.length > 2000 || discussion.history.length > 12)) throw new Error("Invalid discussion.");
	const data = recallFsrsReviewData();
	const resultMap = new Map(data.results.map((item) => [item.id, item]));
	const results = ids.map((id) => resultMap.get(id));
	if (results.some((result) => !result || result.applied)) throw new Error("An answer is unavailable or already linked; refresh first.");
	const nodes = data.nodes.filter((node) => !node.reviewedFlashcard);
	const allowed = new Map(nodes.map((node) => [node.id, node]));
	let model = "analyst"; let inputTokens = 0; let outputTokens = 0;
	const response = await runSubmitAgent<{ items: Array<{ answerId: string; nodeId: string; reason: string }> }>({
		role: "analyst", toolName: "submit_recall_concept_suggestions", toolDescription: "Suggest at most one existing concept per answer with a grounded explanation.",
		parameters: mappingSchema, fill: (value) => value as { items: Array<{ answerId: string; nodeId: string; reason: string }> }, engine: recallMappingEngineOverride.current ?? analystEngine(), signal,
		systemPrompt: "Match each recall question to the single most relevant existing concept. Match meaning, not merely words. Read the learner answer and assessment: for a correct answer explain the tested concept; otherwise describe the supported gap or error. If no concept fits or evidence is insufficient, use an empty nodeId and explain why. Never invent a concept ID. Explain in Vietnamese. If asked a follow-up, answer the question in reason and change the recommendation only when justified. These are proposals; the learner must approve FSRS separately.",
		prompt: JSON.stringify({ concepts: nodes.map((node) => ({ id: node.id, name: node.name, statement: node.statement.slice(0, 250) })), answers: results.map((result) => ({ id: result!.id, subject: result!.sessionTitle, question: result!.draft.question.slice(0, 1800), answer: result!.draft.yourAnswer.slice(0, 2200), correctAnswer: result!.draft.correctAnswer.slice(0, 1500), verdict: result!.verdict, strengths: result!.strengths.slice(0, 700), missing: result!.missing.slice(0, 700), correction: result!.correction.slice(0, 700), priorSuggestion: result!.aiSuggestion })), discussion }),
		onStep: (usage, label) => { model = label; inputTokens += usage.input || 0; outputTokens += usage.output || 0; }, neverSubmitted: "The model did not return concept suggestions.",
		validate: (value) => value.items.length !== ids.length || new Set(value.items.map((item) => item.answerId)).size !== ids.length || value.items.some((item) => !ids.includes(item.answerId) || (item.nodeId && !allowed.has(item.nodeId)) || !item.reason.trim()) ? "Return each supplied answer once, with an existing node ID or an empty ID and an explanation." : null,
	});
	const updates: MappingSuggestion[] = response.items.map((item) => ({ answerId: item.answerId, answerRevision: resultMap.get(item.answerId)!.revision, nodeId: item.nodeId, nodeRevision: item.nodeId ? allowed.get(item.nodeId)!.revision : "", reason: item.reason.trim().slice(0, 2000), model }));
	const latest = recallFsrsReviewData();
	for (const update of updates) {
		const answer = latest.results.find((item) => item.id === update.answerId), node = latest.nodes.find((item) => item.id === update.nodeId);
		if (!answer || answer.applied || answer.revision !== update.answerRevision || (update.nodeId && (!node || node.reviewedFlashcard || node.revision !== update.nodeRevision))) throw new Error("An answer or concept changed during analysis; refresh before trying again.");
	}
	const previous = readSuggestions().filter((item) => !ids.includes(item.answerId));
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomicSync(suggestionsFile(), JSON.stringify({ version: 1, items: [...previous, ...updates] }), { allowInPlaceFallback: true });
	return { items: updates, usage: { input: inputTokens, output: outputTokens }, model };
}

export function confirmRecallFsrs(items: readonly { answerId: string; nodeId: string; rating: number; answerRevision: string; nodeRevision: string }[], now = Date.now()): number {
	if (!items.length || items.length > 100) throw new Error("Select between 1 and 100 answers.");
	const nodes = new Map(graphView().propositions.map((node) => [node.id, node]));
	const reviewed = reviewedFlashcardIds();
	const sources = new Map(assessments().map((item) => [item.id, item]));
	const events = readRecallFsrsEvents();
	const seen = new Set(events.filter((event) => !event.revertedAt).map((event) => event.answerId));
	const additions: RecallFsrsEvent[] = [];
	const batchId = randomUUID();
	for (const item of items) {
		const result = sources.get(item.answerId);
		const node = nodes.get(item.nodeId);
		const answeredAt = result ? Date.parse(result.draft.answeredAt) : NaN;
		if (!result || !node || item.answerRevision !== answerRevision(result) || item.nodeRevision !== nodeRevision(node) || reviewed.has(item.nodeId) || seen.has(item.answerId) || ![1, 2, 3, 4].includes(item.rating) || !Number.isFinite(answeredAt) || answeredAt <= 0 || answeredAt > now) throw new Error("An answer, concept, rating or original answer time is invalid, changed, already saved, or has a separate reviewed Flashcard. Refresh and review again.");
		seen.add(item.answerId);
		additions.push({ answerId: item.answerId, nodeId: item.nodeId, rating: item.rating as 1 | 2 | 3 | 4, answeredAt, confirmedAt: now, batchId });
	}
	// Validate the whole chronological replay before committing any of the batch.
	projectRecallFsrs([...events, ...additions]);
	fs.mkdirSync(path.dirname(recallFsrsLedgerPath()), { recursive: true });
	writeFileAtomicSync(recallFsrsLedgerPath(), JSON.stringify({ version: 1, events: [...events, ...additions] }), { allowInPlaceFallback: true });
	return additions.length;
}

export function undoRecallFsrsBatch(batchId: string, now = Date.now()): number {
	const events = readRecallFsrsEvents();
	const last = events.filter((event) => !event.revertedAt).at(-1)?.batchId;
	if (!last || last !== batchId) throw new Error("The most recent import changed. Refresh before undoing.");
	let count = 0;
	const updated = events.map((event) => {
		if (event.batchId !== batchId || event.revertedAt) return event;
		count++; return { ...event, revertedAt: now };
	});
	projectRecallFsrs(updated);
	writeFileAtomicSync(recallFsrsLedgerPath(), JSON.stringify({ version: 1, events: updated }), { allowInPlaceFallback: true });
	return count;
}

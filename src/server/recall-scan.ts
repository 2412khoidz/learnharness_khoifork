import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { PATHS } from "../../config.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import type { PiEngine } from "../agent/models.ts";
import { collectRecallCandidates, mergeMistakes, ERROR_TYPES, type MistakeDraft, type RecallScanResult, type RecallScanState } from "../core/mistakes.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { readMistakes, updateMistakes } from "../store/mistakes.ts";
import { analystEngine } from "./mistake-analysis.ts";
import { effectiveSettings, stores } from "./stores.ts";

const file = () => path.join(PATHS.data, "recall-scan.json");
const initial = (): RecallScanState => ({ version: 1, status: "idle", total: 0, results: [] });
const kindOf = (kind: string | undefined): "teach" | "practice" | "chat" => kind === "practice" || kind === "chat" ? kind : "teach";
const active = (): { controller?: AbortController } => {
	const g = globalThis as typeof globalThis & { __lhRecallScan?: { controller?: AbortController } };
	return (g.__lhRecallScan ??= {});
};
export const recallScanEngineOverride: { current?: PiEngine } = {};

function readState(): RecallScanState {
	try {
		const state = JSON.parse(fs.readFileSync(file(), "utf8")) as RecallScanState;
		if (state.version !== 1 || !Array.isArray(state.results)) return initial();
		return state;
	} catch { return initial(); }
}

function saveState(state: RecallScanState): void {
	fs.mkdirSync(path.dirname(file()), { recursive: true });
	writeFileAtomicSync(file(), `${JSON.stringify(state)}\n`, { allowInPlaceFallback: true });
}

export function recallScanStatus(): RecallScanState {
	const state = readState();
	if (state.status === "idle" && state.total === 0) state.total = candidates().length;
	// A process restart cannot resume work by itself, but all completed batches
	// remain on disk and the next Start resumes them.
	return state.status === "running" && !active().controller ? { ...state, status: "paused" } : state;
}

export function recallAuditCandidates() {
	return stores.chatStore.listChats().flatMap((chat) => {
		const record = stores.chatStore.getChat(chat.id);
		return record ? collectRecallCandidates(record.id, record.messages).map((c) => ({ ...c, sessionTitle: record.title })) : [];
	});
}
const candidates = recallAuditCandidates;

const assessmentSchema = Type.Object({
	items: Type.Array(Type.Object({
		id: Type.String(),
		verdict: Type.Union(["correct", "partial", "wrong", "dont_know", "uncertain"].map((s) => Type.Literal(s)) as never),
		strengths: Type.String(), missing: Type.String(), correction: Type.String(), evidence: Type.String(),
		errorType: Type.Union(ERROR_TYPES.map((s) => Type.Literal(s)) as never),
		topic: Type.String(), rule: Type.String(),
	})),
});

type Assessment = Omit<RecallScanResult, "draft" | "sessionTitle">;
const NO_ASSESSMENT = "The model did not submit recall assessments.";
// The Google SDK reports a truncated streamed JSON response with this exact
// error. Treat it like a malformed batch, not like an authentication or
// network failure; a smaller batch may fit while preserving saved progress.
const INCOMPLETE_JSON = "Incomplete JSON segment at the end";

export async function assessRecallBatch(batch: ReturnType<typeof candidates>, engine: PiEngine, signal: AbortSignal, onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void, auditContext?: ReadonlyMap<string, unknown>): Promise<Assessment[]> {
	const ids = new Set(batch.map((c) => c.draft.id));
	const response = await runSubmitAgent<{ items: Assessment[] }>({
		role: "analyst", toolName: "submit_recall_assessments", toolDescription: "Return one grounded assessment for every supplied answer.",
		parameters: assessmentSchema, fill: (v) => v as { items: Assessment[] }, engine, signal,
		systemPrompt: "Assess each free-recall answer carefully using the question, committed answer, learner response and subsequent tutor feedback. Distinguish correct, partial, wrong, dont_know and uncertain. Give what was correct, what was missing, a correction, and specific evidence from the learner's answer; never invent reasoning or assume all answers are wrong. If the evidence or answer key is insufficient, use uncertain. Tutor feedback and previous assessments are evidence, not infallible; review them independently. Return every exact id once. Use the learner's language. For correct or uncertain answers, errorType may be knowledge-gap but do not label them mistakes.",
		prompt: JSON.stringify(batch.map(({ draft, feedback }) => ({ id: draft.id, question: draft.question, answer: draft.yourAnswer, committed: draft.correctAnswer, thinking: draft.thinking, tutorFeedback: feedback, ...(auditContext?.has(draft.id) ? { previousAssessment: auditContext.get(draft.id) } : {}) }))),
		onStep: (usage) => onUsage?.(usage), neverSubmitted: NO_ASSESSMENT,
		validate: (value) => {
			if (!Array.isArray(value.items) || value.items.length !== ids.size || new Set(value.items.map((v) => v.id)).size !== ids.size || value.items.some((v) => !ids.has(v.id))) return "Return exactly one result for each supplied id.";
			if (value.items.some((v) => !v.evidence.trim() || ((v.verdict === "wrong" || v.verdict === "partial" || v.verdict === "dont_know") && (!v.missing.trim() || !v.correction.trim())))) return "Include evidence and, for incomplete or wrong answers, the missing point and correction.";
			return null;
		},
	});
	return response.items;
}
const assess = assessRecallBatch;

/** Starts or resumes a sequential batch scan; completed results survive restarts. */
export function startRecallScan(): RecallScanState {
	if (active().controller) return recallScanStatus();
	const pending = candidates();
	const state = readState();
	state.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, modelCalls: 0 };
	const assessed = new Set(state.results.map((r) => r.id));
	const work = pending.filter((c) => !assessed.has(c.draft.id));
	state.total = new Set([...state.results.map((r) => r.id), ...pending.map((c) => c.draft.id)]).size;
	if (!work.length) { state.status = "complete"; state.error = undefined; saveState(state); return state; }
	const controller = new AbortController();
	active().controller = controller;
	state.status = "running"; state.error = undefined; saveState(state);
	void (async () => {
		try {
			const engine = recallScanEngineOverride.current ?? analystEngine();
			const assessAndSave = async (batch: ReturnType<typeof candidates>): Promise<void> => {
				if (controller.signal.aborted) return;
				let grades: Assessment[];
				try {
					grades = await assess(batch, engine, controller.signal, (usage) => {
						const totals = state.usage!;
						totals.input += usage.input || 0; totals.output += usage.output || 0;
						totals.cacheRead += usage.cacheRead || 0; totals.cacheWrite += usage.cacheWrite || 0;
						totals.modelCalls += 1;
						saveState(state);
					});
				} catch (error) {
					// A model may fail to submit a valid result for a large batch.
					// Split only that failure, not provider/auth/network errors, and
					// stop at one answer so a bad response cannot retry forever.
					if (controller.signal.aborted || !(error instanceof Error) || ![NO_ASSESSMENT, INCOMPLETE_JSON].includes(error.message) || batch.length <= 1) throw error;
					const midpoint = Math.floor(batch.length / 2);
					await assessAndSave(batch.slice(0, midpoint));
					await assessAndSave(batch.slice(midpoint));
					return;
				}
				if (controller.signal.aborted) return;
				const byId = new Map(batch.map((c) => [c.draft.id, c]));
				state.results.push(...grades.map((grade) => ({ ...grade, draft: byId.get(grade.id)!.draft, sessionTitle: byId.get(grade.id)!.sessionTitle })));
				saveState(state);
			};
			for (let i = 0; i < work.length; i += 5) {
				if (controller.signal.aborted) break;
				await assessAndSave(work.slice(i, i + 5));
			}
			state.status = controller.signal.aborted ? "paused" : "complete";
		} catch (err) {
			state.status = controller.signal.aborted ? "paused" : "error";
			state.error = controller.signal.aborted ? undefined : err instanceof Error ? err.message : "Recall scan failed.";
		} finally {
			active().controller = undefined;
			saveState(state);
		}
	})();
	return state;
}

export function pauseRecallScan(): RecallScanState {
	active().controller?.abort();
	return recallScanStatus();
}

/** Only the user's selected, evidence-backed misses are written to Mistakes. */
export function saveRecallScanResults(ids: readonly string[]): number {
	const selected = new Set(ids);
	const results = readState().results.filter((r) => selected.has(r.id) && (r.verdict === "wrong" || r.verdict === "partial" || r.verdict === "dont_know"));
	return saveAssessedMistakes(results);
}

function saveAssessedMistakes(results: readonly RecallScanResult[]): number {
	let added = 0;
	updateMistakes((existing) => {
		let records = existing;
		for (const r of results) {
			const chat = stores.chatStore.getChat(r.draft.chatId);
			if (!chat) continue;
			const draft: MistakeDraft = { ...r.draft, kind: r.verdict === "dont_know" ? "unanswered" : "missed", verdict: r.verdict, strengths: r.strengths, missing: r.missing, correction: r.correction, evidence: r.evidence };
			const merged = mergeMistakes(records, [draft], { chatId: chat.id, title: chat.title, kind: kindOf(chat.kind), sources: [], now: new Date().toISOString() });
			added += merged.added.length;
			records = merged.records.map((record) => record.id === r.id && merged.added.length ? { ...record, status: "ready", analysis: { errorType: r.errorType, topic: r.topic, whatYouDid: r.missing, correct: r.correction, rule: r.rule } } : record);
		}
		return records;
	});
	return added;
}

interface LiveGradeAttempt {
	id: string;
	attemptedAt: string;
	result?: RecallScanResult;
}
const liveFile = () => path.join(PATHS.data, "recall-live-grades.json");
function readLiveGrades(): LiveGradeAttempt[] {
	try { const value = JSON.parse(fs.readFileSync(liveFile(), "utf8")); return Array.isArray(value) ? value : []; }
	catch { return []; }
}
function saveLiveGrades(grades: LiveGradeAttempt[]) {
	fs.mkdirSync(path.dirname(liveFile()), { recursive: true });
	writeFileAtomicSync(liveFile(), `${JSON.stringify(grades)}\n`, { allowInPlaceFallback: true });
}
const liveActive = (): Set<string> => {
	const g = globalThis as typeof globalThis & { __lhRecallLiveActive?: Set<string> };
	return (g.__lhRecallLiveActive ??= new Set());
};

export function liveRecallGrades(chatId: string): RecallScanResult[] {
	const result = new Map(readLiveGrades().flatMap((g) => g.result && g.result.draft.chatId === chatId ? [[g.id, g.result] as const] : []));
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return [...result.values()];
	const byId = new Map(collectRecallCandidates(chatId, chat.messages).map((c) => [c.draft.id, c.draft]));
	for (const message of chat.messages) {
		const flag = message as { role?: string; toolName?: string; isError?: boolean; details?: { targetToolCallId?: string; verdict?: string; summary?: string; strengths?: string; missing?: string; correction?: string } };
		if (flag.role !== "toolResult" || flag.toolName !== "flag_mistake" || flag.isError || !flag.details?.targetToolCallId) continue;
		const id = `${chatId}:${flag.details.targetToolCallId}`;
		const draft = byId.get(id);
		const verdict = flag.details.verdict;
		if (!draft || !(verdict === "correct" || verdict === "partial" || verdict === "wrong" || verdict === "dont_know" || verdict === "uncertain")) continue;
		result.set(id, { id, draft, sessionTitle: chat.title, verdict, strengths: flag.details.strengths ?? "", missing: flag.details.missing ?? (verdict === "correct" ? "" : flag.details.summary ?? ""), correction: flag.details.correction ?? "", evidence: "", errorType: "knowledge-gap", topic: "", rule: "" });
	}
	return [...result.values()];
}

/** After a tutor turn, independently assess the current answer if the tutor
 * omitted its structured marker. It never grades old sessions automatically. */
export function gradeLatestRecallAfterTurn(chatId: string): void {
	const record = stores.chatStore.getChat(chatId);
	if (!record || !effectiveSettings().agent.mistakeAnalysis.auto) return;
	const latest = collectRecallCandidates(record.id, record.messages).at(-1);
	if (!latest || !latest.feedback || liveActive().has(latest.draft.id)) return;
	const callId = latest.draft.id.slice(`${chatId}:`.length);
	const answerIndex = record.messages.findIndex((m) => (m as { role?: string; toolCallId?: string }).role === "toolResult" && (m as { toolCallId?: string }).toolCallId === callId);
	const afterAnswer = record.messages.slice(answerIndex + 1);
	if (answerIndex < 0 || afterAnswer.some((m) => (m as { role?: string }).role === "user")) return;
	if (afterAnswer.some((m) => {
		const flag = m as { role?: string; toolName?: string; isError?: boolean; details?: { targetToolCallId?: string } };
		return flag.role === "toolResult" && flag.toolName === "flag_mistake" && !flag.isError && flag.details?.targetToolCallId === callId;
	})) return;
	const prior = readLiveGrades();
	const existing = prior.findLast((entry) => entry.id === latest.draft.id);
	if (existing?.result || (existing && Date.now() - Date.parse(existing.attemptedAt) < 60 * 60 * 1000)) return;
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	const dailyLive = prior.filter((entry) => Date.parse(entry.attemptedAt) >= cutoff);
	const liveIds = new Set(dailyLive.map((entry) => entry.id));
	const otherAnalyses = readMistakes().filter((r) => r.analyzedAt && Date.parse(r.analyzedAt) >= cutoff && !liveIds.has(r.id)).length;
	const globalAnalysis = (globalThis as typeof globalThis & { __lhMistakeAnalysis?: { running: Set<string> } }).__lhMistakeAnalysis;
	if (dailyLive.length + otherAnalyses + (globalAnalysis?.running.size ?? 0) >= effectiveSettings().agent.mistakeAnalysis.dailyCap) return;
	const attempt: LiveGradeAttempt = { id: latest.draft.id, attemptedAt: new Date().toISOString() };
	saveLiveGrades([...prior, attempt]);
	liveActive().add(attempt.id);
	void (async () => {
		try {
			const [grade] = await assess([{ ...latest, sessionTitle: record.title }], recallScanEngineOverride.current ?? analystEngine(), new AbortController().signal);
			if (!grade) return;
			const result: RecallScanResult = { ...grade, draft: latest.draft, sessionTitle: record.title };
			const grades = readLiveGrades();
			saveLiveGrades(grades.map((entry) => entry.id === attempt.id && entry.attemptedAt === attempt.attemptedAt ? { ...entry, result } : entry));
			if (grade.verdict === "wrong" || grade.verdict === "partial" || grade.verdict === "dont_know") saveAssessedMistakes([result]);
		} catch (err) {
			console.error(`[chat ${chatId}] free-recall assessment failed:`, err);
		} finally { liveActive().delete(attempt.id); }
	})();
}

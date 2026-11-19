/** The learner's mistakes (mistakes fork, 2026-11-08 — ported from
 *  vvcdev/learnharness): every quiz/check miss, "I don't know", and practice
 *  problem not solved cleanly, found from the saved sessions, each with a
 *  short error analysis (the error-analysis skill's diagnosis, in-app).
 *  Pure — the store moves the bytes and the analysis service makes the
 *  model call. */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { wrapBareMathForDisplay } from "./bare-math.ts";
import type { LhMessage } from "./native-messages.ts";
import { PRACTICE_CONCLUDE_TOOL, practiceProblemForCall, problemInputForConclude } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";

// ─── taxonomy ────────────────────────────────────────────────────────────────

/** The skill's error types. */
export const ERROR_TYPES = [
	"knowledge-gap",
	"confusable-pair",
	"reversal",
	"setup-error",
	"calculation-slip",
	"misread",
	"incomplete-reasoning",
	"wrong-situation",
	"code-logic-bug",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
	"knowledge-gap": "Knowledge gap",
	"confusable-pair": "Confusable pair",
	reversal: "Reversal",
	"setup-error": "Setup error",
	"calculation-slip": "Calculation slip",
	misread: "Misread",
	"incomplete-reasoning": "Incomplete reasoning",
	"wrong-situation": "Wrong situation",
	"code-logic-bug": "Code or logic bug",
};

export interface MistakeAnalysis {
	errorType: ErrorType;
	/** A short subject label ("static friction on a ramp"). */
	topic: string;
	/** What you did and why that logic fails (1–2 sentences). */
	whatYouDid: string;
	/** What is correct and why, with the real numbers (1–2 sentences). */
	correct: string;
	/** The reusable rule — "Note for next time". */
	rule: string;
}

const clip = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+\n/g, "\n").trim().slice(0, max) : "");

/** Validate a model's submitted analysis; null when unusable. Tolerates
 *  type spellings ("Confusable pair", "confusable_pair"). */
export function parseAnalysis(raw: unknown): MistakeAnalysis | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const typeKey = typeof r.errorType === "string" ? r.errorType.trim().toLowerCase().replace(/[\s_]+/g, "-") : "";
	const errorType = (ERROR_TYPES as readonly string[]).includes(typeKey) ? (typeKey as ErrorType) : null;
	const out = {
		topic: clip(r.topic, 80),
		whatYouDid: clip(r.whatYouDid, 700),
		correct: clip(r.correct, 700),
		rule: clip(r.rule, 400),
	};
	if (!errorType || !out.whatYouDid || !out.correct || !out.rule) return null;
	return { errorType, ...out, topic: out.topic || "General" };
}

// ─── records ─────────────────────────────────────────────────────────────────

export type MistakeKind = "missed" | "unanswered" | "problem";
export type MistakeStatus = "pending" | "ready" | "failed";

export interface MistakeDraft {
	/** `${chatId}:${toolCallId}` — the de-dupe key. */
	id: string;
	chatId: string;
	kind: MistakeKind;
	/** The tool the item came from (quiz, probe, explain, conclude). */
	origin: string;
	question: string;
	yourAnswer: string;
	correctAnswer: string;
	explanation?: string;
	thinking?: string;
	confidence?: number;
	/** Practice problems: how it ended, the agent's verdict, its miss class. */
	outcome?: string;
	verdict?: string;
	/** Structured free-recall feedback: what the learner got right, what was
	 * missing, and a correction. These are separate from a binary score. */
	strengths?: string;
	missing?: string;
	correction?: string;
	evidence?: string;
	missClass?: string;
	answeredAt: string;
}

export interface MistakeRecord extends MistakeDraft {
	sessionTitle: string;
	sessionKind: "teach" | "practice" | "chat";
	/** Names of the files attached to the session (the "note" it came from).
	 *  Kept for record-shape compatibility; the current shell has no session
	 *  source folder, so it is empty. */
	sources: string[];
	createdAt: string;
	status: MistakeStatus;
	/** Model used for the most recent analysis attempt, when recorded. */
	analysisModel?: string;
	analysis?: MistakeAnalysis;
	/** When the last analysis ATTEMPT finished (ready or failed) — the
	 *  rolling 24-hour cost cap counts these. */
	analyzedAt?: string;
	error?: string;
}

export interface RecallScanResult {
	id: string;
	draft: MistakeDraft;
	sessionTitle: string;
	verdict: "correct" | "partial" | "wrong" | "dont_know" | "uncertain";
	strengths: string;
	missing: string;
	correction: string;
	evidence: string;
	errorType: ErrorType;
	topic: string;
	rule: string;
}

export interface RecallScanState {
	version: 1;
	status: "idle" | "running" | "paused" | "complete" | "error";
	total: number;
	results: RecallScanResult[];
	error?: string;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; modelCalls: number };
}

export const FLAG_MISTAKE_TOOL = "flag_mistake";
export const FLAG_MISTAKE_VERDICTS = ["wrong", "partial", "dont_know", "correct", "uncertain"] as const;
export type FlagMistakeVerdict = (typeof FLAG_MISTAKE_VERDICTS)[number];

export interface FlagMistakeDetails {
	targetToolCallId?: string;
	verdict?: FlagMistakeVerdict;
	summary?: string;
	strengths?: string;
	missing?: string;
	correction?: string;
}

const QUIZ_TOOLS = new Set(["quiz", "probe", "explain", "recall", "mcq", "mcq_batch"]);
const EXPLAIN_TOOLS = new Set(["explain", "recall"]);
const UNCLEAN_OUTCOMES = new Set(["solvedWithHints", "movedOn", "surrendered"]);

const OUTCOME_TEXT: Record<string, string> = {
	solvedWithHints: "Solved, but needed hints",
	movedOn: "Moved on without solving",
	surrendered: "Gave up",
};

function practiceThinkingForProblemCall(messages: readonly LhMessage[], problemCallId: string): { text?: string; hasImages: boolean } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as { customType?: string; content?: string; details?: { problemCallId?: unknown; text?: unknown; images?: unknown } };
		if (marker.customType !== "practice-thinking") continue;
		const details = marker.details ?? {};
		if (details.problemCallId !== problemCallId) continue;
		const fromDetails = typeof details.text === "string" ? details.text.trim() : "";
		const hasImages = Array.isArray(details.images) && details.images.length > 0;
		if (fromDetails) return { text: fromDetails, hasImages };
		const fromContent = typeof marker.content === "string" ? marker.content.replace(/^Your thinking:\s*\r?\n?/i, "").trim() : "";
		if (fromContent) return { text: fromContent, hasImages };
		if (hasImages) return { hasImages: true };
	}
	return { hasImages: false };
}

function problemCallIdForConclude(messages: readonly LhMessage[], concludeCallId: string): string | undefined {
	const concludeIndex = messages.findIndex((m) => (m as { role?: string }).role === "assistant" && Array.isArray((m as { content?: unknown }).content) && (m as { content: Array<{ type?: string; id?: string; name?: string }> }).content.some((block) => block.type === "toolCall" && block.id === concludeCallId));
	if (concludeIndex < 0) return undefined;
	const clean = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (!result.isError) clean.add(result.toolCallId);
	}
	for (let i = concludeIndex; i >= 0; i--) {
		const message = messages[i]!;
		if ((message as { role?: string }).role !== "assistant") continue;
		const assistant = message as { content?: Array<{ type?: string; id?: string; name?: string }> };
		for (let bi = (assistant.content?.length ?? 0) - 1; bi >= 0; bi--) {
			const block = assistant.content?.[bi];
			if (!block || block.type !== "toolCall" || !clean.has(block.id ?? "") || block.name === PRACTICE_CONCLUDE_TOOL) continue;
			const occurrence = { messageId: message.id, contentIndex: bi, toolCallId: block.id!, toolName: block.name! };
			if (practiceProblemForCall(messages, occurrence)) return block.id;
		}
	}
	return undefined;
}

function parseFlagVerdict(raw: unknown): FlagMistakeVerdict | undefined {
	return typeof raw === "string" && (FLAG_MISTAKE_VERDICTS as readonly string[]).includes(raw)
		? (raw as FlagMistakeVerdict)
		: undefined;
}

function isEligibleExplainAnswer(details: unknown): details is QuestionAnswerData {
	if (!details || typeof details !== "object") return false;
	const a = details as QuestionAnswerData & { byVoice?: boolean };
	return !a.dismissed && !a.byVoice && a.kind === "explain" && typeof a.questionText === "string" && a.questionText.trim().length > 0;
}

function collectToolCalls(messages: readonly LhMessage[]): Map<string, { args: Record<string, unknown> | undefined }> {
	const calls = new Map<string, { args: Record<string, unknown> | undefined }>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content as { type?: string; id?: string; arguments?: unknown }[]) {
			if (part.type === "toolCall" && typeof part.id === "string") {
				calls.set(part.id, { args: (part.arguments ?? undefined) as Record<string, unknown> | undefined });
			}
		}
	}
	return calls;
}

function collectExplainResults(messages: readonly LhMessage[]): Map<string, { index: number; result: ToolResultMessage }> {
	const explainResults = new Map<string, { index: number; result: ToolResultMessage }>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (result.isError || !EXPLAIN_TOOLS.has(result.toolName)) continue;
		if (!isEligibleExplainAnswer(result.details)) continue;
		explainResults.set(result.toolCallId, { index: i, result });
	}
	return explainResults;
}

/** Resolve which answered explain/recall tool call a `flag_mistake` call
 *  refers to: an explicit eligible id before `beforeIndex`, or else the most
 *  recent eligible explain/recall answer before `beforeIndex`. Pure. */
export function resolveExplainTargetCallId(
	messages: readonly LhMessage[],
	requestedId?: string,
	beforeIndex = messages.length,
): string | null {
	const explainResults = collectExplainResults(messages);
	const clean = typeof requestedId === "string" ? requestedId.trim() : "";
	if (clean) {
		const exact = explainResults.get(clean);
		if (exact && exact.index < beforeIndex) return clean;
		return null;
	}
	for (let i = Math.min(beforeIndex, messages.length) - 1; i >= 0; i--) {
		const m = messages[i];
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (explainResults.has(result.toolCallId)) return result.toolCallId;
	}
	return null;
}

function buildExplainDraft(
	chatId: string,
	toolCallId: string,
	result: ToolResultMessage,
	callArgs: Record<string, unknown> | undefined,
	override?: { verdict?: FlagMistakeVerdict; summary?: string; strengths?: string; missing?: string; correction?: string },
): MistakeDraft | null {
	if (result.isError || !EXPLAIN_TOOLS.has(result.toolName) || !isEligibleExplainAnswer(result.details)) return null;
	const a = result.details;
	const committed =
		a.committed?.trim() ||
		(typeof callArgs?.committedAnswer === "string" ? callArgs.committedAnswer.trim() : "") ||
		"(not recorded)";
	const yourAnswer =
		override?.verdict === "dont_know" && !a.text?.trim()
			? "I don't know"
			: a.text?.trim() || "(no answer)";
	const explanation = override?.summary?.trim() || a.explanation?.trim() || undefined;
	return {
		id: `${chatId}:${toolCallId}`,
		chatId,
		kind: override?.verdict === "dont_know" ? "unanswered" : "missed",
		origin: result.toolName,
		question: a.questionText,
		yourAnswer,
		correctAnswer: committed,
		...(explanation ? { explanation } : {}),
		...((a.thinking ?? a.note) ? { thinking: a.thinking ?? a.note } : {}),
		...(override?.verdict ? { verdict: override.verdict } : {}),
		...(override?.strengths ? { strengths: override.strengths } : {}),
		...(override?.missing ? { missing: override.missing } : {}),
		...(override?.correction ? { correction: override.correction } : {}),
		answeredAt: a.answeredAt || new Date((result.timestamp as number | undefined) ?? 0).toISOString(),
	};
}

/** Answered free-recall checks with nearby tutor feedback, for review. */
export function collectRecallCandidates(chatId: string, messages: readonly LhMessage[]): Array<{ draft: MistakeDraft; feedback: string }> {
	const calls = collectToolCalls(messages);
	const answers = collectExplainResults(messages);
	const candidates: Array<{ draft: MistakeDraft; feedback: string }> = [];
	for (const [toolCallId, { index, result }] of answers) {
		const draft = buildExplainDraft(chatId, toolCallId, result, calls.get(toolCallId)?.args);
		if (!draft || !draft.yourAnswer.trim() || draft.yourAnswer === "(no answer)") continue;
		let feedback = "";
		for (const next of messages.slice(index + 1)) {
			if ((next as { role?: string }).role === "user") break;
			if ((next as { role?: string }).role === "toolResult" && EXPLAIN_TOOLS.has((next as ToolResultMessage).toolName)) break;
			if ((next as { role?: string }).role !== "assistant") continue;
			const content = (next as { content?: unknown }).content;
			if (typeof content === "string") feedback = content.trim();
			else if (Array.isArray(content)) feedback = content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
			if (feedback) break;
		}
		candidates.push({ draft, feedback });
	}
	return candidates;
}

/** Build a MistakeDraft for one answered free-recall (`explain`/`recall`) call
 *  when manually saved by the learner. Returns null when missing or ineligible. */
export function findExplainMistakeByCallId(
	chatId: string,
	messages: readonly LhMessage[],
	toolCallId: string,
): MistakeDraft | null {
	const targetId = toolCallId.trim();
	if (!targetId) return null;
	const calls = collectToolCalls(messages);
	const entry = collectExplainResults(messages).get(targetId);
	if (!entry) return null;
	return buildExplainDraft(chatId, targetId, entry.result, calls.get(targetId)?.args);
}

function labelsFor(a: QuestionAnswerData): { yours: string; correct: string } {
	const labelOf = (index: number) => a.options?.find((o) => o.index === index)?.label;
	const yours = a.dontKnow
		? "I don't know"
		: [...a.answers.map((x) => x.label), ...(a.other ? [a.other] : [])].filter(Boolean).join("; ") || "(no answer)";
	const correct = (a.correctIndices ?? []).map(labelOf).filter((x): x is string => !!x).join("; ") || "(not recorded)";
	return { yours, correct };
}

function quizDraft(chatId: string, id: string, origin: string, a: QuestionAnswerData): MistakeDraft | null {
	// Voice answers are ungraded (no answer key), so they are not misses.
	if (a.dismissed || (a as { byVoice?: boolean }).byVoice || a.kind !== "quiz") return null;
	if (!a.dontKnow && a.correct !== false) return null; // right, or ungraded
	const { yours, correct } = labelsFor(a);
	return {
		id,
		chatId,
		kind: a.dontKnow ? "unanswered" : "missed",
		origin,
		question: a.questionText,
		yourAnswer: yours,
		correctAnswer: correct,
		...(a.explanation ? { explanation: a.explanation } : {}),
		...((a.thinking ?? a.note) ? { thinking: a.thinking ?? a.note } : {}),
		...(typeof a.confidence === "number" ? { confidence: a.confidence } : {}),
		answeredAt: a.answeredAt,
	};
}

/** Every mistake in one session's record, oldest first. Pure. */
export function findMistakes(chatId: string, messages: readonly LhMessage[]): MistakeDraft[] {
	const calls = collectToolCalls(messages);
	const explainResults = collectExplainResults(messages);
	const out: MistakeDraft[] = [];
	const seenIds = new Set<string>();
	const pushDraft = (d: MistakeDraft | null) => {
		if (!d || seenIds.has(d.id)) return;
		seenIds.add(d.id);
		out.push(d);
	};

	for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
		const m = messages[msgIndex];
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (result.isError) continue;
		if (QUIZ_TOOLS.has(result.toolName)) {
			// Forward-compatible with the fork's mcq_batch records (the current
			// shell has no batch tool, but old fork data may still be imported).
			const details = result.details as (QuestionAnswerData & { batch?: QuestionAnswerData[] }) | undefined;
			if (!details) continue;
			if (Array.isArray(details.batch)) {
				details.batch.forEach((item: QuestionAnswerData, i: number) => {
					pushDraft(quizDraft(chatId, `${chatId}:${result.toolCallId}#${i}`, result.toolName, item));
				});
			} else {
				pushDraft(quizDraft(chatId, `${chatId}:${result.toolCallId}`, result.toolName, details));
			}
		} else if (result.toolName === FLAG_MISTAKE_TOOL) {
			const args = calls.get(result.toolCallId)?.args;
			const details = result.details as FlagMistakeDetails | undefined;
			const requestedId =
				typeof details?.targetToolCallId === "string"
					? details.targetToolCallId
					: typeof args?.toolCallId === "string"
						? args.toolCallId
						: undefined;
			const targetId = resolveExplainTargetCallId(messages, requestedId, msgIndex);
			if (!targetId) continue;
			const target = explainResults.get(targetId);
			if (!target) continue;
			const verdict = parseFlagVerdict(details?.verdict) ?? parseFlagVerdict(args?.verdict);
			if (!verdict || verdict === "correct" || verdict === "uncertain") continue;
			const summary =
				typeof details?.summary === "string"
					? details.summary
					: typeof args?.summary === "string"
						? args.summary
						: undefined;
			pushDraft(buildExplainDraft(chatId, targetId, target.result, calls.get(targetId)?.args, {
				verdict, summary,
				strengths: typeof details?.strengths === "string" ? details.strengths : undefined,
				missing: typeof details?.missing === "string" ? details.missing : undefined,
				correction: typeof details?.correction === "string" ? details.correction : undefined,
			}));
		} else if (result.toolName === PRACTICE_CONCLUDE_TOOL) {
			const args = calls.get(result.toolCallId)?.args;
			const outcome = typeof args?.outcome === "string" ? args.outcome : "";
			if (!UNCLEAN_OUTCOMES.has(outcome)) continue;
			const problem = problemInputForConclude(messages, result.toolCallId);
			const statement = typeof problem?.statement === "string" ? problem.statement.trim() : "";
			if (!statement) continue;
			const problemCallId = problemCallIdForConclude(messages, result.toolCallId);
			const thinking = problemCallId ? practiceThinkingForProblemCall(messages, problemCallId) : { hasImages: false };
			const userAnswer = thinking.text || (thinking.hasImages
				? "Bài làm bằng ảnh — xem phiên gốc."
				: "Không có văn bản bài làm — xem phiên gốc.");
			pushDraft({
				id: `${chatId}:${result.toolCallId}`,
				chatId,
				kind: "problem",
				origin: result.toolName,
				question: statement,
				yourAnswer: userAnswer,
				correctAnswer: typeof problem?.modelSolution === "string" ? problem.modelSolution : "(not recorded)",
				outcome,
				...(typeof args?.verdict === "string" ? { verdict: args.verdict } : {}),
				...(typeof args?.missClass === "string" ? { missClass: args.missClass } : {}),
				answeredAt: new Date((result.timestamp as number | undefined) ?? 0).toISOString(),
			});
		}
	}
	return out;
}

/** Add drafts whose id is new (pending analysis); existing records are
 *  untouched except for a refreshed session title/kind/sources. */
export function mergeMistakes(
	existing: readonly MistakeRecord[],
	drafts: readonly MistakeDraft[],
	meta: { chatId: string; title: string; kind: "teach" | "practice" | "chat"; sources: string[]; now: string },
): { records: MistakeRecord[]; added: MistakeRecord[] } {
	const known = new Set(existing.map((r) => r.id));
	const added: MistakeRecord[] = [];
	for (const d of drafts) {
		if (known.has(d.id)) continue;
		known.add(d.id);
		added.push({ ...d, sessionTitle: meta.title, sessionKind: meta.kind, sources: meta.sources, createdAt: meta.now, status: "pending" });
	}
	const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
	const refreshed = existing.map((record) => {
		if (record.chatId !== meta.chatId) return record;
		const restored = restorePracticeAnswer(record, draftsById.get(record.id));
		return { ...restored, sessionTitle: meta.title, sessionKind: meta.kind, sources: meta.sources };
	});
	return { records: [...refreshed, ...added], added };
}

/** Repair only the old status-as-answer bug. Never replace a learner's own
 * answer or alter its analysis, status, timestamps, or other metadata. */
export function restorePracticeAnswer(record: MistakeRecord, draft: MistakeDraft | undefined): MistakeRecord {
	if (record.kind !== "problem" || draft?.kind !== "problem" || draft.id !== record.id) return record;
	if (typeof record.yourAnswer !== "string" || typeof draft.yourAnswer !== "string") return record;
	if (!Object.values(OUTCOME_TEXT).includes(record.yourAnswer.trim())) return record;
	if (!draft.yourAnswer.trim() || record.yourAnswer === draft.yourAnswer) return record;
	return { ...record, yourAnswer: draft.yourAnswer };
}

// ─── the review tab ──────────────────────────────────────────────────────────

export type MistakeGroupBy = "type" | "session" | "topic";

export interface MistakeGroup {
	key: string;
	label: string;
	records: MistakeRecord[];
	/** "3 of 5: Confusable pair" — only when 2+ share a trap. */
	pattern: string | null;
}

const UNANALYZED = "Not analyzed yet";

function topicKey(r: MistakeRecord): string {
	return r.analysis?.topic?.trim() || UNANALYZED;
}

/** A one-line pattern over the records: the commonest value of `field`,
 *  when at least two records share it. */
export function patternLine(records: readonly MistakeRecord[], field: "errorType" | "topic"): string | null {
	const counts = new Map<string, number>();
	let total = 0;
	for (const r of records) {
		const value = field === "errorType" ? (r.analysis ? ERROR_TYPE_LABELS[r.analysis.errorType] : "") : r.analysis?.topic?.trim() ?? "";
		if (!value) continue;
		total += 1;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? ["", 0];
	return n >= 2 ? `${n} of ${total}: ${top}` : null;
}

function recordTimestampMs(r: Pick<MistakeRecord, "answeredAt" | "createdAt">): number {
	const answered = Date.parse(r.answeredAt);
	if (Number.isFinite(answered)) return answered;
	const created = Date.parse(r.createdAt);
	return Number.isFinite(created) ? created : 0;
}

/** Order mistakes newest-first (answeredAt desc, then createdAt desc), keeping relative order on ties. */
export function sortMistakesNewestFirst(records: readonly MistakeRecord[]): MistakeRecord[] {
	return records
		.map((record, index) => ({ record, index, ts: recordTimestampMs(record) }))
		.sort((a, b) => b.ts - a.ts || a.index - b.index)
		.map((entry) => entry.record);
}

export function groupMistakes(records: readonly MistakeRecord[], by: MistakeGroupBy): MistakeGroup[] {
	const groups = new Map<string, MistakeGroup>();
	for (const r of sortMistakesNewestFirst(records)) {
		const [key, label] =
			by === "type"
				? [r.analysis?.errorType ?? "none", r.analysis ? ERROR_TYPE_LABELS[r.analysis.errorType] : UNANALYZED]
				: by === "session"
					? [r.chatId, r.sessionTitle || "Untitled session"]
					: [topicKey(r).toLowerCase(), topicKey(r)];
		const group = groups.get(key) ?? { key, label, records: [], pattern: null };
		group.records.push(r);
		groups.set(key, group);
	}
	const list = [...groups.values()];
	for (const g of list) g.pattern = patternLine(g.records, by === "type" ? "topic" : "errorType");
	return list.sort((a, b) => b.records.length - a.records.length || a.label.localeCompare(b.label));
}

export interface MistakeFilter {
	query?: string;
	errorType?: ErrorType | "";
	chatId?: string;
	kind?: MistakeKind | "";
}

export function filterMistakes(records: readonly MistakeRecord[], f: MistakeFilter): MistakeRecord[] {
	const q = f.query?.trim().toLowerCase() ?? "";
	return records.filter((r) => {
		if (f.errorType && r.analysis?.errorType !== f.errorType) return false;
		if (f.chatId && r.chatId !== f.chatId) return false;
		if (f.kind && r.kind !== f.kind) return false;
		if (!q) return true;
		const hay = [r.question, r.yourAnswer, r.correctAnswer, r.sessionTitle, r.analysis?.topic, r.analysis?.rule, r.analysis?.whatYouDid, ...r.sources]
			.filter(Boolean)
			.join(" ")
			.toLowerCase();
		return hay.includes(q);
	});
}

/**
 * Analysis prose is model-authored Markdown. Models sometimes write code or
 * regex tokens as MATH to avoid escaping backslashes (`$\backslash$d`,
 * `$r"\backslash d\{3\}"$`). Those render as math glyphs that read like raw
 * TeX. Convert only code-shaped math segments to inline code; genuine math
 * (`$[1,4,9,16]$`, `$\alpha_0$`) passes through untouched.
 */
export function presentMistakeAnalysis(text: string): string {
	const cleaned = text
		// $\backslash$d -> `\d`
		.replace(/\$\\backslash\$([A-Za-z])/g, "`\\$1`")
		// $\backslash d$ -> `\d`
		.replace(/\$\\backslash\s+([A-Za-z])\$/g, "`\\$1`")
		// $\{3\}$ -> `{3}`
		.replace(/\$\\\{([^{}$]+)\\\}\$/g, "`{$1}`")
		// $[.-]$ / $[a-z]$ -> regex character class, not an interval list
		.replace(/\$\[([^\],$]*[.-][^\],$]*)\]\$/g, "`[$1]`")
		// $-$ / $.$
		.replace(/\$([.-])\$/g, "`$1`")
		// Phone-number samples are data, not a subtraction: 123-456-7890.
		.replace(/\$(\d{3}[-.]\d{3}[-.]\d{4})\$/g, "`$1`")
		// A whole math segment holding \backslash is regex/code, not math.
		.replace(/\$([^$]*\\backslash[^$]*)\$/g, (_match, inner: string) => {
			const code = inner
				.replace(/\\backslash\s*/g, "\\")
				.replace(/\\\{/g, "{")
				.replace(/\\\}/g, "}")
				.trim();
			return code ? `\`${code}\`` : _match;
		});
	return wrapBareMathForDisplay(cleaned);
}

export interface MistakeSummary {
	total: number;
	missed: number;
	unanswered: number;
	problems: number;
	pending: number;
	byType: { type: ErrorType; count: number }[];
}

export function summarizeMistakes(records: readonly MistakeRecord[]): MistakeSummary {
	const byType = new Map<ErrorType, number>();
	for (const r of records) if (r.analysis) byType.set(r.analysis.errorType, (byType.get(r.analysis.errorType) ?? 0) + 1);
	return {
		total: records.length,
		missed: records.filter((r) => r.kind === "missed").length,
		unanswered: records.filter((r) => r.kind === "unanswered").length,
		problems: records.filter((r) => r.kind === "problem").length,
		pending: records.filter((r) => r.status === "pending").length,
		byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
	};
}

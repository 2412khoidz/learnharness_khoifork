import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelRole } from "../../config.ts";
import { PATHS } from "../../config.ts";
import {
	addDaysToDate,
	applyHabitCheckIn,
	applyJournalEvaluationToConfig,
	applyLlmPlanOutput,
	buildCompactPlannerDigest,
	clipPreservingLatex,
	computeHabitStrengthSummary,
	computeLocalPlannerPlan,
	computePersonalizedMilestoneEstimate,
	DEFAULT_PLANNER_CONFIG,
	evaluatePlanVsActualLocal,
	formatClockMin,
	formatPlainMathPreview,
	INTENSITY_STUDY_BOUNDS,
	isValidDateString,
	localDateString,
	normalizeSubjectKey,
	parseClockMin,
	parseIcsWeeklyEvents,
	parseJournalTextLocal,
	parseLocalSyllabusOutline,
	parseSimpleWeeklyText,
	redactSensitiveJournalText,
	resolveActiveBlockStatus,
	sanitizePlannerConfig,
	WEEKDAYS,
	type ActiveBlockStatus,
	type CoachChatAppliedChange,
	type CoachChatMessage,
	type CoachUndoSnapshot,
	type CognitiveLoad,
	type DailyStudyPlan,
	type DayOverride,
	type FixedWeeklyEvent,
	type HabitCheckInPatch,
	type JournalActivityEntry,
	type LifestyleConfig,
	type LlmCoachPlanPayload,
	type MealSlot,
	type PeakFocusWindow,
	type PersonalizedWorkloadEstimate,
	type PlanComplianceReport,
	type PlannedBlock,
	type PlannerConfig,
	type PlannerEngineMode,
	type PlannerIntensity,
	type PlannerLearningProfile,
	type PlannerPersonalSignals,
	type PlannerSessionSummary,
	type PlannerSubjectSignal,
	type StudyMilestone,
	type SubjectLearningMetrics,
	type SyllabusTopic,
} from "../core/planner.ts";
import {
	computeLearningCapacityReport,
	type LearningCapacityReport,
	type PracticeOutcomeSample,
	type QuizConfidenceSample,
} from "../core/learning-capacity.ts";
import type { ChatRecord } from "../core/contracts/chat.ts";
import type { PlanTree } from "../core/contracts/plan.ts";
import { parseFilePaths } from "../core/file-paths.ts";
import { computeGraphFsrsSummary, emptyGraphFsrsSummary, type GraphFsrsSummary } from "../core/fsrs-graph.ts";
import type { MistakeRecord } from "../core/mistakes.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { emit } from "../core/events.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { convertPdf } from "../agent/subagents/pdf-ops.ts";
import { joinPages } from "../agent/subagents/pdf-markdown.ts";
import { healToolRecord } from "../agent/tools/heal.ts";
import { invalidInputResult, toToolResult } from "../agent/tool-execute.ts";
import { createWebTools } from "../agent/tools/web.ts";
import { healEncodedArguments } from "../core/argument-heal.ts";
import { readMistakes } from "../store/mistakes.ts";
import { buildOutlineDigestIfNeeded, extractEpubText } from "./epub-import.ts";
import { providerKeyPresent } from "./keys.ts";
import { readExamPrepConfig, readExamPrepStatus } from "./exam-prep.ts";
import { graphView } from "./graph.ts";
import { readFlashcardsSnapshot } from "./graph-fsrs.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { stores } from "./stores.ts";

/**
 * Server-side Planner orchestration:
 * - Atomic persistence in `<data>/planner.json`
 * - Compact personal context builder (Graph FSRS + Weak foundations + Mistakes + Chat metadata)
 * - Token-optimized 1-shot AI workflows (Coach Schedule, Multimodal TKB Parser, Exam Syllabus Researcher)
 */

export class PlannerAiUnavailable extends Error {}

export function defaultPlannerPath(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "planner.json");
}

function writeFileAtomic(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, filePath);
}

export function readPlannerConfig(filePath = defaultPlannerPath()): PlannerConfig {
	try {
		if (!fs.existsSync(/* turbopackIgnore: true */ filePath)) {
			return sanitizePlannerConfig(DEFAULT_PLANNER_CONFIG);
		}
		const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8")) as unknown;
		return sanitizePlannerConfig(parsed, DEFAULT_PLANNER_CONFIG);
	} catch {
		return sanitizePlannerConfig(DEFAULT_PLANNER_CONFIG);
	}
}

export function savePlannerConfig(config: PlannerConfig, filePath = defaultPlannerPath()): PlannerConfig {
	const sanitized = sanitizePlannerConfig(config);
	writeFileAtomic(filePath, JSON.stringify(sanitized, null, 2));
	if (path.resolve(filePath) === path.resolve(defaultPlannerPath())) {
		emit("planner-changed", {});
	}
	return sanitized;
}

export interface PlannerPatch {
	engineMode?: PlannerEngineMode;
	intensity?: PlannerIntensity;
	fixedEvents?: FixedWeeklyEvent[];
	milestones?: StudyMilestone[];
	lifestyle?: PlannerConfig["lifestyle"];
	dayOverrides?: PlannerConfig["dayOverrides"];
	dismissedExamProfileIds?: string[];
	mutedSubjects?: string[];
	pinnedSubjects?: string[];
	dailyMaxSubjects?: number;
	realismFactor?: number;
}

export interface PlannerReadOptions {
	plannerFile?: string;
	examPrepFile?: string;
	flashcardsFile?: string;
	mistakesFile?: string;
	now?: number;
}

function resolveChatsFallback(chatsDir?: string, limit = 14): PlannerSessionSummary[] {
	try {
		if (!chatsDir) {
			return stores.chatStore.listChats().slice(0, limit).map((c) => ({
				id: c.id,
				title: c.title,
				kind: c.kind,
				updatedAt: c.updatedAt,
			}));
		}
		if (!fs.existsSync(chatsDir)) return [];
		const out: PlannerSessionSummary[] = [];
		for (const name of fs.readdirSync(chatsDir)) {
			if (!name.endsWith(".json")) continue;
			try {
				const raw = JSON.parse(fs.readFileSync(path.join(chatsDir, name), "utf8")) as Record<string, unknown>;
				const id = typeof raw.id === "string" ? raw.id : name.replace(/\.json$/, "");
				const title = typeof raw.title === "string" ? raw.title : "Untitled";
				const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
				out.push({ id, title, updatedAt });
			} catch {
				// ignore malformed file
			}
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
	} catch {
		return [];
	}
}

const ROLE_DISPLAY_NAMES: Partial<Record<ModelRole, string>> = {
	researcher: "Researcher",
	prober: "Prober",
	analyst: "Analyst",
	sideQuestion: "Coach / Side Q&A",
	visualMaker: "Vision / Diagram",
	pdfReader: "PDF Reader",
};

const SUBJECT_MATCH_NOISE = new Set([
	"day",
	"luyen",
	"tap",
	"bai",
	"on",
	"thi",
	"hoc",
	"mon",
	"cua",
	"va",
	"cho",
	"voi",
	"sinh",
	"vien",
	"olympic",
	"viet",
	"nam",
	"practice",
	"teach",
	"study",
	"nang",
	"cao",
	"co",
]);

function expandSubjectMatchAliases(norm: string): string {
	let out = norm;
	if (out.includes("tri tue nhan tao")) out += " ai";
	if (/\bai\b/.test(out)) out += " tri tue nhan tao";
	if (/\bdse\b/.test(out)) out += " lap trinh xu ly du lieu data science";
	if (out.includes("lap trinh xu ly du lieu")) out += " dse";
	if (/\bxstk\b/.test(out)) out += " xac suat thong ke";
	if (out.includes("xac suat thong ke")) out += " xstk";
	return out;
}

function tokenizeSubjectMatch(norm: string): string[] {
	const raw = expandSubjectMatchAliases(norm)
		.split(/\s+/)
		.filter((t) => t.length >= 2 && !SUBJECT_MATCH_NOISE.has(t));
	return [...new Set(raw)];
}

function extractFirstUserMessageText(chat: ChatRecord): string {
	const msgs = Array.isArray(chat.messages) ? (chat.messages as Array<Record<string, unknown>>) : [];
	for (const m of msgs) {
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content.slice(0, 500);
		if (Array.isArray(m.content)) {
			const parts = (m.content as Array<Record<string, unknown>>)
				.filter((b) => b.type === "text" && typeof b.text === "string")
				.map((b) => String(b.text));
			if (parts.length > 0) return parts.join(" ").slice(0, 500);
		}
		break;
	}
	return "";
}

function matchKnownSubject(
	title: string,
	knownSubjects: readonly string[],
	contextText = "",
): string | undefined {
	const normTitle = normalizeSubjectKey(title);
	const normCtx = normalizeSubjectKey(contextText);
	if (!normTitle && !normCtx) return undefined;

	const expandedTitle = expandSubjectMatchAliases(normTitle);
	const expandedCombined = expandSubjectMatchAliases(`${normTitle} ${normCtx}`.trim());
	const combinedTokens = new Set(tokenizeSubjectMatch(`${normTitle} ${normCtx}`.trim()));

	let best: string | undefined;
	let bestScore = 0;

	for (const sub of knownSubjects) {
		const nk = normalizeSubjectKey(sub);
		if (nk.length < 2) continue;
		const expandedSub = expandSubjectMatchAliases(nk);

		if (normTitle && (normTitle.includes(nk) || nk.includes(normTitle))) {
			const sc = 200 + nk.length;
			if (sc > bestScore) {
				best = sub;
				bestScore = sc;
			}
			continue;
		}
		if (expandedTitle && (expandedTitle.includes(nk) || expandedSub.includes(normTitle))) {
			const sc = 160 + nk.length;
			if (sc > bestScore) {
				best = sub;
				bestScore = sc;
			}
			continue;
		}
		if (normCtx && expandedCombined.includes(nk)) {
			const sc = 140 + nk.length;
			if (sc > bestScore) {
				best = sub;
				bestScore = sc;
			}
			continue;
		}

		const subTokens = tokenizeSubjectMatch(nk);
		if (subTokens.length === 0) continue;
		let matchedTokens = 0;
		for (const tok of subTokens) {
			if (combinedTokens.has(tok)) matchedTokens++;
		}
		const coverage = matchedTokens / subTokens.length;
		const meetsThreshold =
			(subTokens.length === 1 && matchedTokens === 1) ||
			(matchedTokens >= 2 && coverage >= 0.55);
		if (meetsThreshold) {
			const sc = 60 + matchedTokens * 15 + Math.round(coverage * 20);
			if (sc > bestScore) {
				best = sub;
				bestScore = sc;
			}
		}
	}
	return best;
}

function resolveProblemDurationMin(
	concludeTs: number | null,
	lastProblemTs: number | null,
	firstAttemptAfterProblemTs: number | null,
): number | null {
	if (concludeTs === null || lastProblemTs === null || concludeTs <= lastProblemTs) return null;
	const directDeltaMs = concludeTs - lastProblemTs;
	if (directDeltaMs <= 180 * 60_000) {
		const mins = Math.round(Math.min(directDeltaMs, 90 * 60_000) / 60_000);
		return mins >= 2 ? mins : null;
	}
	if (firstAttemptAfterProblemTs !== null && concludeTs > firstAttemptAfterProblemTs) {
		const activeDeltaMs = concludeTs - firstAttemptAfterProblemTs;
		if (activeDeltaMs <= 180 * 60_000) {
			const mins = Math.round(Math.min(activeDeltaMs, 90 * 60_000) / 60_000);
			return mins >= 2 ? mins : null;
		}
	}
	return null;
}

function computeActiveSessionStudyMinutes(chat: ChatRecord): {
	activeMin: number;
	solvedCount: number;
	hintsCount: number;
	unsolvedCount: number;
	problemDurationsMin: number[];
} {
	const msgs = Array.isArray(chat.messages) ? chat.messages : [];
	let activeMs = 0;
	let prevTs: number | null = null;
	let lastProblemTs: number | null = null;
	let firstAttemptTs: number | null = null;
	let solvedCount = 0;
	let hintsCount = 0;
	let unsolvedCount = 0;
	const problemDurationsMin: number[] = [];

	for (const m of msgs as Array<Record<string, unknown>>) {
		const ts = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : null;
		if (ts !== null && prevTs !== null) {
			const delta = ts - prevTs;
			if (delta > 0) activeMs += Math.min(delta, 25 * 60_000);
		}
		if (ts !== null) prevTs = ts;
		if (m.role === "user" && lastProblemTs !== null && firstAttemptTs === null && ts !== null && ts > lastProblemTs) {
			firstAttemptTs = ts;
		}

		const blocks = Array.isArray(m.content) ? m.content : [];
		for (const blk of blocks as Array<Record<string, unknown>>) {
			if (blk.type !== "toolCall") continue;
			const name = typeof blk.name === "string" ? blk.name : "";
			const args = (blk.arguments && typeof blk.arguments === "object" ? blk.arguments : {}) as Record<string, unknown>;
			if (name === "problem") {
				if (ts !== null) {
					lastProblemTs = ts;
					firstAttemptTs = null;
				}
			} else if (name === "conclude") {
				const outcome = typeof args.outcome === "string" ? args.outcome : "";
				if (outcome === "solved") solvedCount++;
				else if (outcome === "solvedWithHints") hintsCount++;
				else if (outcome === "movedOn" || outcome === "surrendered") unsolvedCount++;
				const durMin = resolveProblemDurationMin(ts, lastProblemTs, firstAttemptTs);
				if (durMin !== null) problemDurationsMin.push(durMin);
				lastProblemTs = null;
				firstAttemptTs = null;
			}
		}
	}

	const turnCount = Array.isArray(chat.turns) ? chat.turns.length : msgs.length;
	const fallbackMin = Math.min(120, Math.max(5, turnCount * 4));
	const activeMin = activeMs > 0 ? Math.max(5, Math.round(activeMs / 60_000)) : fallbackMin;
	return { activeMin, solvedCount, hintsCount, unsolvedCount, problemDurationsMin };
}

function buildPlannerLearningProfile(opts: {
	config: PlannerConfig;
	subjectSignals: readonly PlannerSubjectSignal[];
	flashcards: ReturnType<typeof readFlashcardsSnapshot> | null;
	propIdToSubject: Map<string, string>;
	sessions: readonly PlannerSessionSummary[];
	chatsDir?: string;
}): PlannerLearningProfile {
	const { config, subjectSignals, flashcards, propIdToSubject, sessions, chatsDir } = opts;
	const buckets = new Map<string, {
		subject: string;
		clusterId?: string;
		fsrsReviews: number;
		fsrsPasses: number;
		fsrsLapses: number;
		diffSum: number;
		stabSum: number;
		trackedNodes: number;
		practiceSessions: number;
		teachSessions: number;
		solvedCount: number;
		hintsCount: number;
		unsolvedCount: number;
		problemMins: number[];
		sessionMins: number[];
		loggedMinutes: number;
	}>();

	const ensureBucket = (subject: string, clusterId?: string) => {
		const key = normalizeSubjectKey(subject);
		let b = buckets.get(key);
		if (!b) {
			b = {
				subject,
				...(clusterId ? { clusterId } : {}),
				fsrsReviews: 0,
				fsrsPasses: 0,
				fsrsLapses: 0,
				diffSum: 0,
				stabSum: 0,
				trackedNodes: 0,
				practiceSessions: 0,
				teachSessions: 0,
				solvedCount: 0,
				hintsCount: 0,
				unsolvedCount: 0,
				problemMins: [],
				sessionMins: [],
				loggedMinutes: 0,
			};
			buckets.set(key, b);
		}
		return b;
	};

	for (const sig of subjectSignals) ensureBucket(sig.label, sig.clusterId);
	for (const ms of config.milestones) ensureBucket(ms.subject);

	let totalFsrsReviews = 0;
	let totalFsrsPasses = 0;
	const rawReviews = Array.isArray(flashcards?.reviews) ? flashcards!.reviews : [];
	for (const r of rawReviews as Array<Record<string, unknown>>) {
		const rating = Number(r.rating);
		if (!Number.isFinite(rating) || rating < 1 || rating > 4) continue;
		totalFsrsReviews++;
		if (rating >= 3) totalFsrsPasses++;
		const propId = typeof r.propositionId === "string" ? r.propositionId : "";
		const subj = propId ? propIdToSubject.get(propId) : undefined;
		if (subj) {
			const b = ensureBucket(subj);
			b.fsrsReviews++;
			if (rating >= 3) b.fsrsPasses++;
			if (rating === 1) b.fsrsLapses++;
		}
	}

	if (flashcards?.propositions) {
		for (const [propId, entry] of Object.entries(flashcards.propositions)) {
			const sched = entry?.schedule;
			if (!sched || !sched.reps) continue;
			const subj = propIdToSubject.get(propId);
			if (!subj) continue;
			const b = ensureBucket(subj);
			b.trackedNodes++;
			if (typeof sched.difficulty === "number") b.diffSum += sched.difficulty;
			if (typeof sched.stability === "number") b.stabSum += sched.stability;
		}
	}

	let totalPracticeSessions = 0;
	let totalTeachSessions = 0;
	let totalSolved = 0;
	let totalProblemsConcluded = 0;
	const allProblemMins: number[] = [];
	const allTeachMins: number[] = [];

	const knownBucketSubjects = [...buckets.values()].map((b) => b.subject);
	for (const s of sessions.slice(0, 40)) {
		const chat = readChatSafe(s.id, chatsDir);
		if (!chat) continue;
		const stats = computeActiveSessionStudyMinutes(chat);
		const isPractice = (chat.kind ?? s.kind) === "practice" || stats.solvedCount + stats.hintsCount + stats.unsolvedCount > 0;
		if (isPractice) totalPracticeSessions++;
		else {
			totalTeachSessions++;
			allTeachMins.push(stats.activeMin);
		}
		totalSolved += stats.solvedCount;
		totalProblemsConcluded += stats.solvedCount + stats.hintsCount + stats.unsolvedCount;
		allProblemMins.push(...stats.problemDurationsMin);

		const matchedSubj = matchKnownSubject(
			chat.title || s.title,
			knownBucketSubjects,
			extractFirstUserMessageText(chat),
		);
		if (matchedSubj) {
			const b = ensureBucket(matchedSubj);
			if (isPractice) b.practiceSessions++;
			else b.teachSessions++;
			b.solvedCount += stats.solvedCount;
			b.hintsCount += stats.hintsCount;
			b.unsolvedCount += stats.unsolvedCount;
			b.problemMins.push(...stats.problemDurationsMin);
			b.sessionMins.push(stats.activeMin);
		}
	}

	let loggedStudyDays = 0;
	const dailyHoursList: number[] = [];
	for (const log of Object.values(config.logs)) {
		const loggedSum = Object.values(log.loggedStudyMinBySubject).reduce((a, b) => a + b, 0);
		const journalStudy = (log.actualEntries ?? [])
			.filter((e) => e.category === "study")
			.reduce((a, b) => a + b.minutes, 0);
		const dayMin = Math.max(loggedSum, journalStudy);
		if (dayMin >= 15) {
			loggedStudyDays++;
			dailyHoursList.push(dayMin / 60);
		}
		for (const [subj, mins] of Object.entries(log.loggedStudyMinBySubject)) {
			const b = ensureBucket(subj);
			b.loggedMinutes += mins;
		}
	}

	const sufficientData =
		(totalFsrsReviews >= 8 || totalProblemsConcluded >= 8) &&
		(totalPracticeSessions + totalTeachSessions >= 2 || loggedStudyDays >= 2);
	const sufficiencyReason = sufficientData
		? `Calibrated from ${totalFsrsReviews} FSRS reviews · ${totalProblemsConcluded} concluded problems · ${totalPracticeSessions + totalTeachSessions} sessions`
		: `Baseline only: need ≥8 FSRS reviews or ≥8 concluded Practice problems and ≥2 sessions/days (currently ${totalFsrsReviews} FSRS, ${totalProblemsConcluded} problems, ${totalPracticeSessions + totalTeachSessions} sessions)`;

	const bySubject: Record<string, SubjectLearningMetrics> = {};
	for (const b of buckets.values()) {
		const retentionRatePct = b.fsrsReviews > 0 ? Math.round((b.fsrsPasses / b.fsrsReviews) * 100) : null;
		const lapseRatePct = b.fsrsReviews > 0 ? Math.round((b.fsrsLapses / b.fsrsReviews) * 100) : null;
		const avgDifficulty = b.trackedNodes > 0 ? Math.round((b.diffSum / b.trackedNodes) * 10) / 10 : null;
		const avgStabilityDays = b.trackedNodes > 0 ? Math.round((b.stabSum / b.trackedNodes) * 10) / 10 : null;
		const totalProb = b.solvedCount + b.hintsCount + b.unsolvedCount;
		const practiceSolveRatePct = totalProb > 0 ? Math.round((b.solvedCount / totalProb) * 100) : null;
		const avgMinutesPerProblem =
			b.problemMins.length > 0
				? Math.round(b.problemMins.reduce((a, v) => a + v, 0) / b.problemMins.length)
				: null;
		const avgMinutesPerSession =
			b.sessionMins.length > 0
				? Math.round(b.sessionMins.reduce((a, v) => a + v, 0) / b.sessionMins.length)
				: null;

		let paceFactor = 1.0;
		const subjectEvidence = b.fsrsReviews + totalProb * 2;
		if (b.fsrsReviews >= 4 || totalProb >= 2) {
			const confScale = sufficientData ? 1 : Math.min(1, subjectEvidence / 8);
			const diffAdjust = avgDifficulty !== null ? (avgDifficulty - 5.2) * 0.045 : 0;
			const solveAdjust = practiceSolveRatePct !== null ? (72 - practiceSolveRatePct) * 0.004 : 0;
			const lapseAdjust = lapseRatePct !== null ? Math.max(0, lapseRatePct - 15) * 0.004 : 0;
			const rawPace = 1 + (diffAdjust + solveAdjust + lapseAdjust) * confScale;
			paceFactor = Math.min(1.65, Math.max(0.75, Math.round(rawPace * 100) / 100));
		}

		bySubject[b.subject] = {
			subject: b.subject,
			...(b.clusterId ? { clusterId: b.clusterId } : {}),
			fsrsReviews: b.fsrsReviews,
			fsrsTrackedNodes: b.trackedNodes,
			retentionRatePct,
			lapseRatePct,
			avgDifficulty,
			avgStabilityDays,
			practiceSessions: b.practiceSessions,
			practiceSolvedCount: b.solvedCount,
			practiceHintsCount: b.hintsCount,
			practiceUnsolvedCount: b.unsolvedCount,
			practiceSolveRatePct,
			avgMinutesPerProblem,
			avgMinutesPerSession,
			teachSessions: b.teachSessions,
			loggedPlannerMinutes: b.loggedMinutes,
			paceFactor,
		};
	}

	const overallRetentionPct = totalFsrsReviews > 0 ? Math.round((totalFsrsPasses / totalFsrsReviews) * 100) : null;
	const overallSolveRatePct = totalProblemsConcluded > 0 ? Math.round((totalSolved / totalProblemsConcluded) * 100) : null;
	const avgMinutesPerProblem =
		allProblemMins.length > 0 ? Math.round(allProblemMins.reduce((a, v) => a + v, 0) / allProblemMins.length) : null;
	const avgMinutesPerTopic =
		allTeachMins.length > 0 ? Math.round(allTeachMins.reduce((a, v) => a + v, 0) / allTeachMins.length) : null;
	const sustainableDailyHours =
		dailyHoursList.length >= 2
			? Math.round((dailyHoursList.reduce((a, v) => a + v, 0) / dailyHoursList.length) * 10) / 10
			: null;

	return {
		sufficientData,
		sufficiencyReason,
		totalFsrsReviews,
		totalPracticeSessions,
		totalTeachSessions,
		loggedStudyDays,
		overallRetentionPct,
		overallSolveRatePct,
		avgMinutesPerProblem,
		avgMinutesPerTopic,
		sustainableDailyHours,
		realismFactor: config.realismFactor ?? 1.0,
		bySubject,
	};
}

function collectSessionWorkItemsForSubject(
	matchingSessions: readonly PlannerSessionSummary[],
	chatsDir?: string,
): {
	attachedFiles: string[];
	activePlanTopics: string[];
	pendingProblems: string[];
	sessionNotesPreview?: string;
} {
	const filesSet = new Set<string>();
	const planTopics: string[] = [];
	const pendingProblems: string[] = [];
	const notesList: string[] = [];

	const addFileMatches = (raw: string) => {
		for (const fp of parseFilePaths(raw)) {
			if (fp.kind !== "path") continue;
			const base = path.basename(fp.path || "").trim();
			if (base && base.length <= 70) filesSet.add(base);
		}
		const docMatches = raw.match(/[\wÀ-ỹ.\- ()]+\.(?:pdf|epub|md|txt|csv|docx?|tex)/gi) ?? [];
		for (const dm of docMatches) {
			const clean = path.basename(dm.trim()).slice(0, 70);
			if (clean) filesSet.add(clean);
		}
	};

	const walkPlanTree = (tree: PlanTree | undefined) => {
		if (!tree?.nodes || !Array.isArray(tree.nodes)) return;
		for (const node of tree.nodes) {
			const label = (node.title || "").trim();
			if (label && !planTopics.includes(label) && planTopics.length < 5) {
				planTopics.push(clipPreservingLatex(label, 90));
			}
		}
	};

	for (const s of matchingSessions.slice(0, 3)) {
		addFileMatches(s.title);
		const chat = readChatSafe(s.id, chatsDir);
		if (!chat) continue;
		if (chat.notes?.trim()) {
			addFileMatches(chat.notes);
			if (notesList.length < 2) notesList.push(clipPreservingLatex(chat.notes, 110));
		}
		walkPlanTree(chat.tree);

		const msgs = Array.isArray(chat.messages) ? chat.messages : [];
		const problemStems = new Map<string, string>();
		const concludedClean = new Set<string>();
		let lastProblemStem = "";
		let lastConcludedOutcome = "";

		for (const m of msgs as Array<Record<string, unknown>>) {
			if (m.role === "user") {
				if (typeof m.content === "string") addFileMatches(m.content);
				else if (Array.isArray(m.content)) {
					for (const b of m.content as Array<{ type?: string; text?: string }>) {
						if (b.type === "text" && b.text) addFileMatches(b.text);
					}
				}
			}
			const blocks = Array.isArray(m.content) ? m.content : [];
			for (const blk of blocks as Array<Record<string, unknown>>) {
				if (blk.type !== "toolCall") continue;
				const name = typeof blk.name === "string" ? blk.name : "";
				const id = typeof blk.id === "string" ? blk.id : "";
				const args = (blk.arguments && typeof blk.arguments === "object" ? blk.arguments : {}) as Record<string, unknown>;
				if (name === "problem") {
					const rawStmt = typeof args.statement === "string" ? args.statement : typeof args.title === "string" ? args.title : "";
					const cleanStmt = clipPreservingLatex(rawStmt.split(/\r?\n/)[0] ?? rawStmt, 95);
					if (cleanStmt) {
						if (id) problemStems.set(id, cleanStmt);
						lastProblemStem = cleanStmt;
						lastConcludedOutcome = "";
					}
				} else if (name === "conclude") {
					const out = typeof args.outcome === "string" ? args.outcome : "";
					lastConcludedOutcome = out;
					if (out === "solved" && id) concludedClean.add(id);
				}
			}
		}
		if (lastProblemStem && lastConcludedOutcome !== "solved" && pendingProblems.length < 3) {
			pendingProblems.push(lastProblemStem);
		} else {
			for (const [id, stmt] of problemStems) {
				if (!concludedClean.has(id) && pendingProblems.length < 3 && !pendingProblems.includes(stmt)) {
					pendingProblems.push(stmt);
				}
			}
		}
	}

	return {
		attachedFiles: [...filesSet].slice(0, 4),
		activePlanTopics: planTopics,
		pendingProblems,
		...(notesList.length > 0 ? { sessionNotesPreview: notesList.join(" | ").slice(0, 160) } : {}),
	};
}

export function buildPlannerPersonalSignals(
	config: PlannerConfig,
	opts?: PlannerReadOptions & { chatsDir?: string; date?: string },
): PlannerPersonalSignals {
	const now = opts?.now ?? Date.now();
	const date = isValidDateString(opts?.date) ? opts!.date : localDateString(now);

	const examPrep = opts?.examPrepFile || opts?.flashcardsFile || opts?.mistakesFile
		? readExamPrepStatus({
			examPrepFile: opts?.examPrepFile,
			flashcardsFile: opts?.flashcardsFile,
			mistakesFile: opts?.mistakesFile,
			now,
		})
		: readExamPrepStatus({ now });

	const sessions = resolveChatsFallback(opts?.chatsDir);

	// Per-cluster detailed graph + FSRS metrics (compact metadata only)
	const subjectSignals: PlannerSubjectSignal[] = [];
	const propIdToSubject = new Map<string, string>();
	let loadedFlashcards: ReturnType<typeof readFlashcardsSnapshot> | null = null;
	try {
		const isolatedTestMode = Boolean(opts?.plannerFile && !opts.flashcardsFile);
		const graph = isolatedTestMode ? { propositions: [], chains: [], clusters: [], sessions: {} } : graphView();
		const flashcards = isolatedTestMode ? null : readFlashcardsSnapshot(opts?.flashcardsFile);
		loadedFlashcards = flashcards;

		if (graph.propositions.length > 0 && examPrep.availableScopes.length > 0) {
			const nodesById = new Map(graph.propositions.map((n) => [n.id, n]));
			const clusterLookup = new Map((graph.clusters ?? []).map((c) => [c.id, c]));
			const birthLookup = new Map(birthSessionPartition(graph.propositions).map((c) => [c.id, c.members]));

			for (const scope of examPrep.availableScopes) {
				const explicitCluster = clusterLookup.get(scope.id);
				const memberIds = explicitCluster?.members ?? birthLookup.get(scope.id) ?? [];
				for (const nid of memberIds) {
					if (!propIdToSubject.has(nid)) propIdToSubject.set(nid, scope.label);
				}
				const memberNodes = memberIds
					.map((id) => nodesById.get(id))
					.filter((n): n is NonNullable<typeof n> => Boolean(n));
				if (memberNodes.length === 0) continue;

				const memberSet = new Set(memberNodes.map((n) => n.id));
				const memberChains = graph.chains.filter((c) => memberSet.has(c.conclusion));
				const fsrs = flashcards
					? computeGraphFsrsSummary({ nodes: memberNodes, chains: memberChains }, flashcards, now)
					: emptyGraphFsrsSummary();

				const dueSampleNames: string[] = [];
				const weakSampleNames: string[] = [];
				const untrackedSampleNames: string[] = [];
				for (const n of memberNodes) {
					const info = fsrs.nodes[n.id];
					if (!info) continue;
					if (info.due && dueSampleNames.length < 4) dueSampleNames.push(n.name);
					if ((info.isFoundation && info.memoryBand !== "untracked" && info.retrievability !== null && info.retrievability < 0.7) && weakSampleNames.length < 4) {
						weakSampleNames.push(n.name);
					}
					if (info.state === "untracked" && untrackedSampleNames.length < 5) {
						untrackedSampleNames.push(n.name);
					}
				}

				const needle = scope.label.toLowerCase();
				const matchingSessions = sessions.filter((s) => s.title.toLowerCase().includes(needle) || needle.includes(s.title.toLowerCase()));
				const sessionItems = isolatedTestMode && !opts?.chatsDir
					? { attachedFiles: [], activePlanTopics: [], pendingProblems: [] }
					: collectSessionWorkItemsForSubject(matchingSessions, opts?.chatsDir);

				subjectSignals.push({
					clusterId: scope.id,
					label: scope.label,
					nodeCount: scope.nodeCount,
					trackedCount: scope.trackedCount,
					dueCount: scope.dueCount,
					weakCount: fsrs.counts.weakFoundations,
					untrackedCount: fsrs.counts.untrackedFoundations,
					readinessPct: scope.readinessPct,
					dueSampleNames,
					weakSampleNames,
					...(untrackedSampleNames.length > 0 ? { untrackedSampleNames } : {}),
					...(sessionItems.attachedFiles.length > 0 ? { attachedFiles: sessionItems.attachedFiles } : {}),
					...(sessionItems.activePlanTopics.length > 0 ? { activePlanTopics: sessionItems.activePlanTopics } : {}),
					...(sessionItems.pendingProblems.length > 0 ? { pendingProblems: sessionItems.pendingProblems } : {}),
					...(sessionItems.sessionNotesPreview ? { sessionNotesPreview: sessionItems.sessionNotesPreview } : {}),
					recentChatTitles: matchingSessions.slice(0, 3).map((s) => s.title),
					lastStudiedAt: matchingSessions[0]?.updatedAt ?? null,
				});
			}
		} else {
			for (const scope of examPrep.availableScopes) {
				subjectSignals.push({
					clusterId: scope.id,
					label: scope.label,
					nodeCount: scope.nodeCount,
					trackedCount: scope.trackedCount,
					dueCount: scope.dueCount,
					weakCount: 0,
					untrackedCount: Math.max(0, scope.nodeCount - scope.trackedCount),
					readinessPct: scope.readinessPct,
					dueSampleNames: [],
					weakSampleNames: [],
					recentChatTitles: [],
					lastStudiedAt: null,
				});
			}
		}
	} catch {
		// Never fail planner read if graph isn't initialized
	}

	const recentLogs = Object.values(config.logs)
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, 7);
	const energyVals = recentLogs.map((l) => l.energyScore).filter((e): e is 1 | 2 | 3 | 4 | 5 => typeof e === "number");
	const avgEnergy = energyVals.length > 0
		? Math.round((energyVals.reduce((a, b) => a + b, 0) / energyVals.length) * 10) / 10
		: null;
	const latestBedtime = recentLogs.find((l) => l.actualBedtime)?.actualBedtime ?? null;
	const avgStudyMin = recentLogs.length > 0
		? Math.round(
			recentLogs.reduce(
				(acc, l) => acc + Object.values(l.loggedStudyMinBySubject).reduce((s, v) => s + v, 0),
				0,
			) / recentLogs.length,
		)
		: 0;

	// ActivityWatch-inspired passive session tracking: credit active chats updated today to matching subjects
	const autoTrackedStudyMinBySubject: Record<string, number> = {};
	const matchers: Array<{ subject: string; needles: string[] }> = [];
	const seenSubj = new Set<string>();
	for (const m of config.milestones) {
		const key = m.subject.toLowerCase();
		if (seenSubj.has(key)) continue;
		seenSubj.add(key);
		matchers.push({ subject: m.subject, needles: [key, m.title.toLowerCase()].filter(Boolean) });
	}
	for (const sig of subjectSignals) {
		const key = sig.label.toLowerCase();
		if (seenSubj.has(key)) continue;
		seenSubj.add(key);
		matchers.push({ subject: sig.label, needles: [key] });
	}
	for (const s of sessions) {
		if (!s.updatedAt || s.updatedAt.slice(0, 10) !== date) continue;
		const titleLower = s.title.toLowerCase();
		const hit = matchers.find((m) =>
			m.needles.some((needle) => needle.length >= 2 && (titleLower.includes(needle) || needle.includes(titleLower))),
		);
		if (hit) {
			autoTrackedStudyMinBySubject[hit.subject] = (autoTrackedStudyMinBySubject[hit.subject] ?? 0) + 25;
		}
	}

	const cleanedMistakeHints = examPrep.mistakeHints
		? {
			...examPrep.mistakeHints,
			recentRules: examPrep.mistakeHints.recentRules.map((r) => clipPreservingLatex(r, 200)).filter(Boolean),
		}
		: undefined;

	const learningProfile = buildPlannerLearningProfile({
		config,
		subjectSignals,
		flashcards: loadedFlashcards,
		propIdToSubject,
		sessions: opts?.plannerFile && !opts.chatsDir ? [] : sessions,
		chatsDir: opts?.chatsDir,
	});

	return {
		date,
		examPrep,
		subjectSignals,
		...(cleanedMistakeHints ? { mistakeHints: cleanedMistakeHints } : {}),
		recentSessions: sessions,
		autoTrackedStudyMinBySubject,
		learningProfile,
		habitTrend: {
			loggedDays: recentLogs.length,
			avgEnergy,
			latestBedtime,
			avgStudyMin,
		},
	};
}

export interface PlannerSnapshotResponse {
	config: PlannerConfig;
	plan: DailyStudyPlan;
	activeStatus: ActiveBlockStatus;
	signals: PlannerPersonalSignals;
	aiAvailability: {
		coach: { available: boolean; modelLabel: string | null };
		vision: { available: boolean; modelLabel: string | null };
		research: { available: boolean; modelLabel: string | null; webSearch: boolean };
		availableRoles: Array<{ role: ModelRole; label: string; modelLabel: string }>;
	};
}

interface ResolvedPlannerEngine {
	role: ModelRole;
	modelLabel: string;
	engine: PiEngine;
}

export function resolvePlannerEngine(
	kind: "coach" | "vision" | "research",
	preferredRole?: ModelRole,
): ResolvedPlannerEngine | null {
	const settings = stores.settingsStore.readSettings();
	const defaultOrder: ModelRole[] =
		kind === "vision"
			? ["visualMaker", "pdfReader", "prober", "researcher", "analyst"]
			: kind === "research"
				? ["researcher", "prober", "analyst"]
				: ["prober", "sideQuestion", "researcher", "analyst"];
	const roleOrder: ModelRole[] = preferredRole ? [preferredRole, ...defaultOrder.filter((r) => r !== preferredRole)] : defaultOrder;

	for (const role of roleOrder) {
		const spec = resolveRoleSpec(role, settings);
		if (!spec) continue;
		if (!providerKeyPresent(spec.provider)) continue;
		const engine = piEngineForSpec(spec, true);
		return {
			role,
			modelLabel: `${spec.provider}:${spec.id}`,
			engine,
		};
	}
	return null;
}

export function listAvailablePlannerRoles(): Array<{ role: ModelRole; label: string; modelLabel: string }> {
	const settings = stores.settingsStore.readSettings();
	const roles: ModelRole[] = ["researcher", "prober", "analyst", "sideQuestion", "visualMaker", "pdfReader"];
	const out: Array<{ role: ModelRole; label: string; modelLabel: string }> = [];
	for (const role of roles) {
		const spec = resolveRoleSpec(role, settings);
		if (!spec || !providerKeyPresent(spec.provider)) continue;
		out.push({
			role,
			label: ROLE_DISPLAY_NAMES[role] ?? role,
			modelLabel: `${spec.provider}:${spec.id}`,
		});
	}
	return out;
}

export function getPlannerAiAvailability() {
	const coach = resolvePlannerEngine("coach");
	const vision = resolvePlannerEngine("vision");
	const research = resolvePlannerEngine("research");
	return {
		coach: { available: Boolean(coach), modelLabel: coach?.modelLabel ?? null },
		vision: { available: Boolean(vision), modelLabel: vision?.modelLabel ?? null },
		research: {
			available: Boolean(research),
			modelLabel: research?.modelLabel ?? null,
			webSearch: searchAvailable(),
		},
		availableRoles: listAvailablePlannerRoles(),
	};
}

function syncExamPrepProfilesIntoConfig(
	config: PlannerConfig,
	signals: PlannerPersonalSignals,
	date: string,
): { config: PlannerConfig; changed: boolean } {
	const exams = signals.examPrep.config.exams ?? [];
	if (exams.length === 0) return { config, changed: false };
	const dismissed = new Set(config.dismissedExamProfileIds ?? []);
	let changed = false;
	const milestones = config.milestones.map((m) => ({
		...m,
		clusterIds: [...m.clusterIds],
		syllabusTopics: m.syllabusTopics.map((t) => ({ ...t })),
	}));

	for (const ex of exams) {
		if (dismissed.has(ex.id)) continue;
		const scopeLabels = signals.examPrep.availableScopes
			.filter((s) => ex.clusterIds.includes(s.id))
			.map((s) => s.label);
		const dueDate = ex.date && isValidDateString(ex.date) ? ex.date : addDaysToDate(date, 21);
		const existing = milestones.find((m) => m.examProfileId === ex.id || m.id === `ep_${ex.id}`);
		if (!existing) {
			milestones.push({
				id: `ep_${ex.id}`,
				kind: /olympic|olp|contest|competition|hsg/i.test(ex.title) ? "competition" : "exam",
				title: ex.title,
				subject: scopeLabels[0] || ex.title,
				dueDate,
				priority: ex.pace === "crash-course" ? 3 : 2,
				cognitiveLoad: "heavy",
				clusterIds: [...ex.clusterIds],
				estimatedHours: ex.pace === "thorough" ? 24 : ex.pace === "efficient" ? 16 : 10,
				completedHours: 0,
				syllabusTopics: [],
				notes: "",
				sourceSummary: "Synced from Exam Prep profile",
				examProfileId: ex.id,
			});
			changed = true;
		} else {
			if (existing.title !== ex.title) {
				existing.title = ex.title;
				changed = true;
			}
			if (ex.date && isValidDateString(ex.date) && existing.dueDate !== ex.date) {
				existing.dueDate = ex.date;
				changed = true;
			}
			const mergedClusters = [...new Set([...existing.clusterIds, ...ex.clusterIds])];
			if (mergedClusters.length !== existing.clusterIds.length) {
				existing.clusterIds = mergedClusters;
				changed = true;
			}
			if (!existing.examProfileId) {
				existing.examProfileId = ex.id;
				changed = true;
			}
		}
	}

	if (!changed) return { config, changed: false };
	return {
		config: sanitizePlannerConfig({ ...config, milestones }),
		changed: true,
	};
}

export function readPlannerSnapshot(opts?: PlannerReadOptions & { chatsDir?: string; date?: string }): PlannerSnapshotResponse {
	const now = opts?.now ?? Date.now();
	const date = isValidDateString(opts?.date) ? opts!.date : localDateString(now);
	const filePath = opts?.plannerFile ?? defaultPlannerPath();
	let config = readPlannerConfig(filePath);
	const signals = buildPlannerPersonalSignals(config, { ...opts, date, now });
	const synced = syncExamPrepProfilesIntoConfig(config, signals, date);
	if (synced.changed) {
		config = synced.config;
	}

	// Use saved LLM/local plan for `date` if already generated, else compute fast 0-token local plan
	let plan = synced.changed ? undefined : config.plans[date];
	if (!plan) {
		plan = computeLocalPlannerPlan(config, signals, now);
		config = savePlannerConfig(
			{
				...config,
				plans: { ...config.plans, [date]: plan },
			},
			filePath,
		);
	} else {
		if (!plan.habitStrength) {
			plan = {
				...plan,
				habitStrength: computeHabitStrengthSummary(config, date),
			};
		}
		if (synced.changed) {
			config = savePlannerConfig(config, filePath);
		}
	}

	return {
		config,
		plan,
		activeStatus: resolveActiveBlockStatus(plan, config.logs[date], now),
		signals,
		aiAvailability: getPlannerAiAvailability(),
	};
}

export function patchPlannerConfig(
	patch: PlannerPatch,
	opts?: PlannerReadOptions & { chatsDir?: string },
): PlannerSnapshotResponse {
	const now = opts?.now ?? Date.now();
	const date = localDateString(now);
	const filePath = opts?.plannerFile ?? defaultPlannerPath();
	const current = readPlannerConfig(filePath);

	let dismissedExamProfileIds = current.dismissedExamProfileIds ?? [];
	if (patch.dismissedExamProfileIds !== undefined) {
		dismissedExamProfileIds = patch.dismissedExamProfileIds;
	} else if (patch.milestones !== undefined) {
		const nextExamIds = new Set(patch.milestones.map((m) => m.examProfileId).filter((id): id is string => Boolean(id)));
		const dropped = current.milestones
			.map((m) => m.examProfileId)
			.filter((id): id is string => Boolean(id))
			.filter((id) => !nextExamIds.has(id));
		if (dropped.length > 0) {
			dismissedExamProfileIds = [...new Set([...dismissedExamProfileIds, ...dropped])];
		}
	}

	const next: PlannerConfig = sanitizePlannerConfig({
		...current,
		...(patch.engineMode !== undefined ? { engineMode: patch.engineMode } : {}),
		...(patch.intensity !== undefined ? { intensity: patch.intensity } : {}),
		...(patch.fixedEvents !== undefined ? { fixedEvents: patch.fixedEvents } : {}),
		...(patch.milestones !== undefined ? { milestones: patch.milestones } : {}),
		...(patch.lifestyle !== undefined ? { lifestyle: patch.lifestyle } : {}),
		...(patch.dayOverrides !== undefined ? { dayOverrides: patch.dayOverrides } : {}),
		...(patch.mutedSubjects !== undefined ? { mutedSubjects: patch.mutedSubjects } : {}),
		...(patch.pinnedSubjects !== undefined ? { pinnedSubjects: patch.pinnedSubjects } : {}),
		...(patch.dailyMaxSubjects !== undefined ? { dailyMaxSubjects: patch.dailyMaxSubjects } : {}),
		...(patch.realismFactor !== undefined ? { realismFactor: patch.realismFactor } : {}),
		dismissedExamProfileIds,
		updatedAt: new Date(now).toISOString(),
	});

	const signals = buildPlannerPersonalSignals(next, { ...opts, date, now });
	const synced = patch.dismissedExamProfileIds !== undefined
		? syncExamPrepProfilesIntoConfig(next, signals, date)
		: { config: next, changed: false };
	const resolvedNext = synced.config;

	const scheduleInputsChanged =
		patch.intensity !== undefined ||
		patch.fixedEvents !== undefined ||
		patch.milestones !== undefined ||
		patch.lifestyle !== undefined ||
		patch.dayOverrides !== undefined ||
		patch.mutedSubjects !== undefined ||
		patch.pinnedSubjects !== undefined ||
		patch.dailyMaxSubjects !== undefined ||
		patch.realismFactor !== undefined ||
		synced.changed;

	if (scheduleInputsChanged || !resolvedNext.plans[date]) {
		const freshLocal = computeLocalPlannerPlan(resolvedNext, signals, now);
		resolvedNext.plans = { ...resolvedNext.plans, [date]: freshLocal };
	}

	const saved = savePlannerConfig(resolvedNext, filePath);
	const activePlan = saved.plans[date]!;
	return {
		config: saved,
		plan: activePlan,
		activeStatus: resolveActiveBlockStatus(activePlan, saved.logs[date], now),
		signals,
		aiAvailability: getPlannerAiAvailability(),
	};
}

export function checkInPlannerHabit(
	patch: HabitCheckInPatch,
	opts?: PlannerReadOptions & { chatsDir?: string },
): PlannerSnapshotResponse {
	const now = opts?.now ?? Date.now();
	const filePath = opts?.plannerFile ?? defaultPlannerPath();
	const current = readPlannerConfig(filePath);
	const updated = applyHabitCheckIn(current, patch, now);
	const saved = savePlannerConfig(updated, filePath);
	return readPlannerSnapshot({ ...opts, date: patch.date ?? localDateString(now), now });
}

// ─── Shared Single-Submit Runner (supports optional vision images + extra tools) ───

async function runPlannerSubmit<T>(opts: {
	role: ModelRole;
	engine: PiEngine;
	systemPrompt: string;
	promptText: string;
	images?: ImageContent[];
	toolName: string;
	toolDescription: string;
	parameters: ReturnType<typeof Type.Object>;
	extraTools?: Record<string, AgentTool<any>>;
	maxTurns?: number;
	signal?: AbortSignal;
	validate?: (value: T) => string | null;
	fill: (raw: unknown) => T;
}): Promise<T> {
	let submitted: T | undefined;
	const tools: AgentTool<any, any>[] = [
		...(opts.extraTools ? Object.values(healToolRecord(opts.extraTools)) : []),
		{
			name: opts.toolName,
			label: opts.toolName,
			description: opts.toolDescription,
			parameters: opts.parameters,
			prepareArguments: (args) => healEncodedArguments(args, opts.parameters) as never,
			execute: async (_toolCallId, input) => {
				const value = opts.fill(input);
				const problem = opts.validate?.(value) ?? null;
				if (problem) return invalidInputResult(opts.toolName, [problem]);
				submitted = value;
				return toToolResult(submitted);
			},
		},
	];

	const messages: AgentMessage[] | undefined = opts.images && opts.images.length > 0
		? [
			{
				role: "user",
				content: [{ type: "text", text: opts.promptText }, ...opts.images],
				timestamp: Date.now(),
			},
		]
		: undefined;

	await runSubagent(tools, {
		role: opts.role,
		engine: opts.engine,
		systemPrompt: opts.systemPrompt,
		...(messages ? { messages } : { prompt: opts.promptText }),
		maxTurns: opts.maxTurns ?? 4,
		abortSignal: opts.signal,
		shouldStop: (_msg, toolResults) => toolResults.some((r) => r.toolName === opts.toolName && !r.isError),
	});

	if (!submitted) throw new Error("Model completed without submitting structured output.");
	return submitted;
}

// ─── 1. AI Smart Planner Coach (Token-Optimized Digest) ──────────────────────

const llmPlanSchema = Type.Object({
	coachSummary: Type.String({ description: "2-3 concise sentences of actionable coaching & sleep/subject balance rationale." }),
	minDailyStudyHours: Type.Number({ description: "Recommended minimum study hours today." }),
	quotas: Type.Array(
		Type.Object({
			subject: Type.String(),
			targetMin: Type.Number(),
			checklist: Type.Array(Type.String()),
		}),
	),
	blocks: Type.Array(
		Type.Object({
			startTime: Type.String({ description: "HH:MM 24h" }),
			endTime: Type.String({ description: "HH:MM 24h" }),
			type: Type.Union([Type.Literal("study"), Type.Literal("hobby"), Type.Literal("break")]),
			subject: Type.Optional(Type.String()),
			title: Type.String(),
			cognitiveLoad: Type.Optional(Type.Union([Type.Literal("heavy"), Type.Literal("medium"), Type.Literal("light")])),
			reason: Type.Optional(Type.String()),
			actionTopic: Type.Optional(Type.String()),
		}),
	),
});

export async function generatePlannerSchedule(opts: {
	mode?: PlannerEngineMode;
	preferredRole?: ModelRole;
	date?: string;
	focusNote?: string;
	plannerFile?: string;
	examPrepFile?: string;
	flashcardsFile?: string;
	mistakesFile?: string;
	now?: number;
	engineOverride?: PiEngine;
	signal?: AbortSignal;
}): Promise<{ snapshot: PlannerSnapshotResponse; warning?: string }> {
	const now = opts.now ?? Date.now();
	const date = isValidDateString(opts.date) ? opts.date : localDateString(now);
	const filePath = opts.plannerFile ?? defaultPlannerPath();
	let config = readPlannerConfig(filePath);
	const signals = buildPlannerPersonalSignals(config, { ...opts, date, now });
	const baseline = computeLocalPlannerPlan(config, signals, now);

	const effectiveMode = opts.mode ?? config.engineMode;
	if (effectiveMode === "local") {
		config = savePlannerConfig(
			{
				...config,
				engineMode: opts.mode ? "local" : config.engineMode,
				plans: { ...config.plans, [date]: baseline },
				updatedAt: new Date(now).toISOString(),
			},
			filePath,
		);
		return {
			snapshot: {
				config,
				plan: baseline,
				activeStatus: resolveActiveBlockStatus(baseline, config.logs[date], now),
				signals,
				aiAvailability: getPlannerAiAvailability(),
			},
		};
	}

	const resolved = opts.engineOverride
		? { role: "prober" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("coach", opts.preferredRole);

	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured for AI Coach (open Settings -> Models).");
	}

	const digest = buildCompactPlannerDigest(config, signals, baseline);
	const systemPrompt = `You are a hyper-specific, disciplined, empathetic Student Study & Wellness Coach inside ChronoHarness.
Analyze the compact daily student digest and call submit_daily_plan ONCE.

STRICT RULES:
1. Intensity Envelope (NON-NEGOTIABLE): Read \`intensityEnvelope\` ({ mode, minStudyHours, targetStudyHours, maxStudyHours, minHobbyMin, maxSubjectsToday }).
   - Total study minutes across blocks MUST respect [minStudyHours, maxStudyHours]. NEVER exceed maxStudyHours in Healthy or Balanced mode!
   - Schedule at least minHobbyMin minutes of real recharge / sport / relaxation.
2. Hyper-Specific Tasks (NO GENERIC FILLER):
   - NEVER write vague filler like "Chọn một chủ đề chưa theo dõi", "Bài tập toán AI", "Làm bài tập ghi lỗ hổng", or "Khảo sát kiến thức mới".
   - Instead, EVERY study block title, actionTopic, and quota checklist item MUST reference the EXACT theorems, files, open PlanTree chapters, unfinished problems, or mistake rules from \`knowledgeSignals\` (\`attachedFiles\`, \`activePlanTopics\`, \`pendingProblems\`, \`dueSample\`, \`weakSample\`, \`untrackedSample\`) and \`milestones\` (\`openTopics\`, \`notesHint\`).
   - Do NOT invent problem numbers that aren't in the digest; cite what is present cleanly.
3. No Overlaps & Subject Focus: Never overlap \`fixedEventsToday\`, meals, or sleep. Obey \`mutedSubjects\` (omit them) and prioritize \`focusSubjectsToday\` if set. Interleave at most \`maxSubjectsToday\` subjects.
4. Sleep Continuity, Food Coma Shield & Early-Waking Care:
   - Check \`awakeWindow.earlyWakingDetected\` & \`actualLastSleepHours\`. If waking at 4-5 AM occurs or sleep was short, soften the first morning hour, place a 20-25m restorative midday power nap around 13:00 (NEVER after 14:30), and enforce the exact screen-off \`windDownBufferMin\` before \`recommendedBedtime\`.
   - Check \`lifestyleBalance.postDinnerComaProtection\` and \`eveningDipWindow\`: immediately after Dinner, place a 15m \`Post-Meal Walk & Hydration\` break; NEVER schedule \`heavy\` cognitive blocks inside \`eveningDipWindow\` (~20:00-21:15) — reserve that window for active/offline hobbies or \`light\` flashcards/review.
5. Hobbies, Gaming & Discreet Wellness Guardrails: Check \`lifestyleBalance\`.
   - If \`gameBudgetMin > 0\`, schedule a clean bounded gaming slot STRICTLY BEFORE \`recommendedBedtime - gameCutoffBeforeBedMin\`.
   - If \`wellnessGuardrail.enabled\` is true, subtly protect the listed \`riskWindows\` (\`post_nap_wake\`, \`early_morning_wake\`, \`post_dinner_slump\`, \`late_night\`, \`idle_afternoon\`, \`alone_in_room\`) by placing a 10m upright transition reset right after waking / midday nap and structured wind-down or offline hobby blocks with **100% discreet, neutral labels** on the timeline (never mention sensitive biological details on visible block titles).
6. Match the user's language (Vietnamese if subjects/milestones are Vietnamese). Max 11 dynamic blocks.`;

	const promptText = [
		"Compact student state digest:",
		JSON.stringify(digest),
		opts.focusNote?.trim() ? `Extra request for today: ${opts.focusNote.trim()}` : null,
	]
		.filter(Boolean)
		.join("\n\n");

	const payload = await runPlannerSubmit<LlmCoachPlanPayload>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt,
		promptText,
		toolName: "submit_daily_plan",
		toolDescription: "Submit the structured daily study schedule.",
		parameters: llmPlanSchema,
		signal: opts.signal,
		fill: (raw) => raw as LlmCoachPlanPayload,
		validate: (val) =>
			Array.isArray(val.blocks) && val.blocks.length > 0 && val.coachSummary.trim()
				? null
				: "Provide coachSummary and at least one study block inside open windows.",
	});

	const aiPlan = applyLlmPlanOutput(baseline, payload, config, resolved.modelLabel);
	config = savePlannerConfig(
		{
			...config,
			engineMode: "llm",
			plans: { ...config.plans, [date]: aiPlan },
			updatedAt: new Date(now).toISOString(),
		},
		filePath,
	);

	return {
		snapshot: {
			config,
			plan: aiPlan,
			activeStatus: resolveActiveBlockStatus(aiPlan, config.logs[date], now),
			signals,
			aiAvailability: getPlannerAiAvailability(),
		},
	};
}

// ─── 2. Fixed Weekly Schedule Parser (Text + Multimodal Timetable Photo) ─────

const weeklyScheduleSchema = Type.Object({
	events: Type.Array(
		Type.Object({
			dayOfWeek: Type.Union(WEEKDAYS.map((d) => Type.Literal(d)) as never),
			startTime: Type.String({ description: "HH:MM 24h" }),
			endTime: Type.String({ description: "HH:MM 24h" }),
			title: Type.String(),
			category: Type.Union([
				Type.Literal("class"),
				Type.Literal("club"),
				Type.Literal("work"),
				Type.Literal("commute"),
				Type.Literal("other"),
			]),
		}),
	),
	notes: Type.Optional(Type.String()),
});

export async function parseWeeklyScheduleInput(opts: {
	rawText?: string;
	images?: ImageContent[];
	preferLocal?: boolean;
	engineOverride?: PiEngine;
	signal?: AbortSignal;
}): Promise<{ events: FixedWeeklyEvent[]; used: "local" | "ai"; modelLabel?: string; notes?: string }> {
	const rawText = opts.rawText?.trim() ?? "";
	const images = opts.images ?? [];
	if (!rawText && images.length === 0) {
		throw new Error("Provide schedule text or a timetable image.");
	}

	// Zero-token `.ics` RFC 5545 parser
	if (images.length === 0 && /BEGIN:V(?:CALENDAR|EVENT)/i.test(rawText)) {
		return {
			events: parseIcsWeeklyEvents(rawText),
			used: "local",
			notes: "Parsed .ics calendar locally (0 tokens).",
		};
	}

	// 0-token local path if requested OR text-only without any configured AI key
	if (opts.preferLocal && images.length === 0) {
		return { events: parseSimpleWeeklyText(rawText), used: "local" };
	}

	const resolved = opts.engineOverride
		? { role: "visualMaker" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine(images.length > 0 ? "vision" : "research");

	if (!resolved) {
		if (images.length === 0 && rawText) {
			const parsed = parseSimpleWeeklyText(rawText);
			if (parsed.length > 0) return { events: parsed, used: "local", notes: "Parsed locally (no AI model configured)." };
		}
		throw new PlannerAiUnavailable(
			images.length > 0
				? "Configure a Vision/Strong model in Settings -> Models to read timetable images."
				: "No AI model configured, and text lines did not match pattern like 'T2 07:30-09:30 Giai tich'.",
		);
	}

	const systemPrompt = `You extract a student's recurring weekly fixed timetable (TKB, classes, labs, clubs, part-time work) from free-form text and/or a timetable screenshot.
Call submit_weekly_schedule ONCE.
Map Vietnamese days (Thứ 2/T2=mon, Thứ 3/T3=tue, Thứ 4/T4=wed, Thứ 5/T5=thu, Thứ 6/T6=fri, Thứ 7/T7=sat, Chủ nhật/CN=sun).
Convert tiết học / period numbers to realistic clock times if needed (e.g. Tiết 1-3 -> 07:00-09:30, Tiết 4-6 -> 09:35-12:00 unless explicit times appear in the timetable). Keep 24h HH:MM format.`;

	const promptText = rawText
		? `Extract all fixed weekly recurring blocks from this schedule:\n\n${rawText}`
		: "Extract all fixed weekly recurring classes/events visible in this timetable image.";

	const result = await runPlannerSubmit<{
		events: Array<Omit<FixedWeeklyEvent, "id">>;
		notes?: string;
	}>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt,
		promptText,
		images,
		toolName: "submit_weekly_schedule",
		toolDescription: "Submit extracted weekly fixed events.",
		parameters: weeklyScheduleSchema,
		signal: opts.signal,
		fill: (raw) => raw as { events: Array<Omit<FixedWeeklyEvent, "id">>; notes?: string },
		validate: (val) => (Array.isArray(val.events) ? null : "Provide an events array."),
	});

	const stamped: FixedWeeklyEvent[] = result.events.map((e, idx) => ({
		...e,
		id: `fix_ai_${Date.now()}_${idx}`,
	}));
	// Run through planner sanitizer to guarantee strict valid times/days
	const cleaned = sanitizePlannerConfig({ fixedEvents: stamped }).fixedEvents;
	return {
		events: cleaned,
		used: "ai",
		modelLabel: resolved.modelLabel,
		notes: result.notes,
	};
}

// ─── 3. 1-Shot Exam / Competition Syllabus & Workload Researcher ──────────────

const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * Reuse ChronoHarness's native PDF/EPUB/Markdown extractors so Milestone materials
 * accept `.pdf`, `.epub`, `.md`, `.txt`, `.tex`, and `.ics` directly inside `/planner`.
 */
export async function extractPlannerMaterialFile(
	fileName: string,
	bytes: Uint8Array,
): Promise<{ text: string; notice?: string }> {
	if (bytes.byteLength === 0) throw new Error("Empty file.");
	if (bytes.byteLength > MAX_MATERIAL_BYTES) throw new Error("File exceeds 25 MB limit.");
	const lower = fileName.toLowerCase();

	if (lower.endsWith(".epub")) {
		const epub = extractEpubText(bytes);
		if (epub.kind === "unreadable") throw new Error(epub.error);
		const digested = buildOutlineDigestIfNeeded(epub.text);
		return {
			text: digested.text.slice(0, 24_000),
			notice: `Extracted EPUB (${epub.chapterCount} ${epub.chapterCount === 1 ? "section" : "sections"}).`,
		};
	}

	const isPdf = lower.endsWith(".pdf") || PDF_MAGIC.every((b, i) => bytes[i] === b);
	if (isPdf) {
		const pdf = await convertPdf(bytes, 400);
		if (pdf.kind === "unreadable") throw new Error("Could not read this PDF file.");
		if (pdf.kind === "too-long") throw new Error("PDF exceeds 400 pages.");
		const text = joinPages(pdf.pages);
		if (!text.trim()) throw new Error("This PDF contains image-only scanned pages without selectable text.");
		const digested = buildOutlineDigestIfNeeded(text);
		return {
			text: digested.text.slice(0, 24_000),
			notice: `Extracted PDF (${pdf.pages.length} pages).`,
		};
	}

	if (bytes.subarray(0, 8192).includes(0)) {
		throw new Error("Unsupported binary file. Upload PDF, EPUB, MD, TXT, TEX, or ICS.");
	}
	const decoded = new TextDecoder().decode(bytes);
	const digested = buildOutlineDigestIfNeeded(decoded);
	return {
		text: digested.text.slice(0, 24_000),
		...(digested.outlined ? { notice: `Generated outline digest (${digested.sectionCount} sections).` } : {}),
	};
}

function readChatSafe(chatId: string, chatsDir?: string): ChatRecord | null {
	try {
		if (chatsDir) {
			const filePath = path.join(chatsDir, `${chatId}.json`);
			if (!fs.existsSync(filePath)) return null;
			return JSON.parse(fs.readFileSync(filePath, "utf8")) as ChatRecord;
		}
		return stores.chatStore.getChat(chatId) ?? null;
	} catch {
		return null;
	}
}

export function buildLinkedClusterContext(opts: {
	clusterIds?: readonly string[];
	examProfileId?: string;
	examPrepFile?: string;
	flashcardsFile?: string;
	chatsDir?: string;
}): {
	resolvedClusterIds: string[];
	resolvedSubject: string;
	summaryText: string;
	topicHints: SyllabusTopic[];
	linkedLabels: string[];
} {
	const resolvedSet = new Set(opts.clusterIds ?? []);
	let resolvedSubject = "";

	if (opts.examProfileId) {
		const epCfg = readExamPrepConfig(opts.examPrepFile);
		const profile = (epCfg.exams ?? []).find((e) => e.id === opts.examProfileId);
		if (profile) {
			if (!resolvedSubject) resolvedSubject = profile.title;
			for (const cid of profile.clusterIds) resolvedSet.add(cid);
		}
	}

	const resolvedClusterIds = [...resolvedSet];
	if (resolvedClusterIds.length === 0) {
		return { resolvedClusterIds: [], resolvedSubject, summaryText: "", topicHints: [], linkedLabels: [] };
	}

	const sections: string[] = [];
	const topicHints: SyllabusTopic[] = [];
	const seenTopics = new Set<string>();
	const linkedLabels: string[] = [];

	let graphPropositions: ReturnType<typeof graphView>["propositions"] = [];
	let graphClusters: ReturnType<typeof graphView>["clusters"] = [];
	let fileSources: Record<string, string> = {};
	try {
		const isolatedTest = Boolean((opts.chatsDir || opts.examPrepFile) && !opts.flashcardsFile);
		if (!isolatedTest) {
			const g = graphView();
			graphPropositions = g.propositions;
			graphClusters = g.clusters ?? [];
			fileSources = g.fileSources ?? {};
		}
	} catch {
		// Graph not initialized
	}

	const propById = new Map(graphPropositions.map((p) => [p.id, p]));
	const birthMap = new Map(birthSessionPartition(graphPropositions).map((c) => [c.id, c.members]));
	const explicitMap = new Map(graphClusters.map((c) => [c.id, c]));

	for (const cid of resolvedClusterIds.slice(0, 10)) {
		const chat = !cid.startsWith("src_") ? readChatSafe(cid, opts.chatsDir) : null;
		const label = chat?.title || fileSources[cid] || explicitMap.get(cid)?.label || cid;
		linkedLabels.push(label);
		if (!resolvedSubject && label && label !== cid) resolvedSubject = label;

		const memberIds = explicitMap.get(cid)?.members ?? birthMap.get(cid) ?? [];
		const concepts = memberIds
			.map((id) => propById.get(id))
			.filter((n): n is NonNullable<typeof n> => Boolean(n))
			.slice(0, 20);

		const lines: string[] = [`[Session/Cluster: ${label}]`];
		if (concepts.length > 0) {
			lines.push(`Graph concepts (${concepts.length}): ${concepts.map((c) => c.name).join(", ")}`);
		}

		const tree: PlanTree | undefined = chat?.tree;
		if (tree?.nodes && tree.nodes.length > 0) {
			lines.push(`Lesson plan topics: ${tree.nodes.map((n) => n.title).join(" -> ")}`);
			for (const node of tree.nodes.slice(0, 8)) {
				const key = node.title.trim().toLowerCase();
				if (key && !seenTopics.has(key) && topicHints.length < 12) {
					seenTopics.add(key);
					topicHints.push({ id: `lnk_${topicHints.length}`, title: node.title.trim().slice(0, 100), estHours: 2.5, done: false });
				}
			}
		}

		if (chat?.notes?.trim()) {
			lines.push(`Learner notes:\n${chat.notes.trim().slice(0, 1000)}`);
		}

		if (chat?.messages && chat.messages.length > 0) {
			const docRefs: string[] = [];
			for (const msg of chat.messages) {
				if (msg.role !== "user") continue;
				const contentArr = Array.isArray(msg.content) ? msg.content : [];
				for (const part of contentArr) {
					if (part.type !== "text") continue;
					for (const fp of parseFilePaths(part.text)) {
						if (fp.kind === "path" && !docRefs.includes(fp.path)) docRefs.push(fp.path);
					}
				}
			}
			if (docRefs.length > 0) {
				lines.push(`Referenced files: ${docRefs.slice(0, 6).join(", ")}`);
			}
		}

		if (topicHints.length < 12 && concepts.length > 0) {
			for (const concept of concepts.slice(0, 6)) {
				const key = concept.name.trim().toLowerCase();
				if (key && !seenTopics.has(key) && topicHints.length < 12) {
					seenTopics.add(key);
					topicHints.push({ id: `grp_${topicHints.length}`, title: concept.name.trim().slice(0, 100), estHours: 2, done: false });
				}
			}
		}
		sections.push(lines.join("\n"));
	}

	return {
		resolvedClusterIds,
		resolvedSubject,
		summaryText: sections.join("\n\n").slice(0, 5000),
		topicHints,
		linkedLabels,
	};
}

const examSyllabusSchema = Type.Object({
	subject: Type.String({ description: "Clean subject/area name (e.g. 'Olympic Giải tích', 'Linear Algebra')." }),
	cognitiveLoad: Type.Union([Type.Literal("heavy"), Type.Literal("medium"), Type.Literal("light")]),
	priority: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
	estimatedHours: Type.Number({ description: "Realistic total study hours needed to prepare thoroughly." }),
	syllabusTopics: Type.Array(
		Type.Object({
			title: Type.String(),
			estHours: Type.Number(),
		}),
	),
	sourceSummary: Type.String({ description: "Brief note on competition format / syllabus scope / citations." }),
});

export interface ResearchTraceStep {
	id: string;
	phase: "linked_context" | "web_search" | "web_fetch" | "synthesizing" | "done" | "error";
	message: string;
	detail?: string;
	urls?: string[];
	timestamp: string;
}

export async function researchExamSyllabus(opts: {
	title: string;
	kind?: StudyMilestone["kind"];
	dueDate?: string;
	materialsText?: string;
	clusterIds?: string[];
	examProfileId?: string;
	pullOnly?: boolean;
	preferLocal?: boolean;
	preferredRole?: ModelRole;
	examPrepFile?: string;
	flashcardsFile?: string;
	chatsDir?: string;
	engineOverride?: PiEngine;
	signal?: AbortSignal;
	onStep?: (step: ResearchTraceStep) => void;
}): Promise<{
	subject: string;
	cognitiveLoad: CognitiveLoad;
	priority: 1 | 2 | 3;
	estimatedHours: number;
	syllabusTopics: SyllabusTopic[];
	sourceSummary: string;
	pulledContext?: string;
	modelLabel: string;
	usedWebSearch: boolean;
	trace: ResearchTraceStep[];
}> {
	const trace: ResearchTraceStep[] = [];
	const pushStep = (step: Omit<ResearchTraceStep, "id" | "timestamp">) => {
		const entry: ResearchTraceStep = {
			...step,
			id: `tr_${Date.now()}_${trace.length}`,
			timestamp: new Date().toISOString(),
		};
		trace.push(entry);
		opts.onStep?.(entry);
	};

	const linked = buildLinkedClusterContext({
		clusterIds: opts.clusterIds,
		examProfileId: opts.examProfileId,
		examPrepFile: opts.examPrepFile,
		flashcardsFile: opts.flashcardsFile,
		chatsDir: opts.chatsDir,
	});
	const title = opts.title.trim() || linked.resolvedSubject || "Study Milestone";

	pushStep({
		phase: "linked_context",
		message: linked.linkedLabels.length > 0
			? `Probed ${linked.linkedLabels.length} linked graph/session cluster(s): ${linked.linkedLabels.join(", ")}`
			: `Prepared prompt context for "${title}"`,
		...(linked.topicHints.length > 0 ? { detail: `Found ${linked.topicHints.length} topic hints from Graph & PlanTree` } : {}),
	});

	if (opts.pullOnly) {
		const manualParsed = opts.materialsText?.trim() ? parseLocalSyllabusOutline(opts.materialsText) : { syllabusTopics: [], estimatedHours: 0 };
		const combinedTopics = [...linked.topicHints];
		const seen = new Set(combinedTopics.map((t) => t.title.toLowerCase()));
		for (const mt of manualParsed.syllabusTopics) {
			if (!seen.has(mt.title.toLowerCase()) && combinedTopics.length < 20) {
				seen.add(mt.title.toLowerCase());
				combinedTopics.push(mt);
			}
		}
		const sumH = Math.max(1, Math.round(combinedTopics.reduce((a, t) => a + t.estHours, 0) * 10) / 10);
		pushStep({ phase: "done", message: `Pulled ${combinedTopics.length} linked topics (~${sumH}h) with 0 tokens.` });
		return {
			subject: (linked.resolvedSubject || title).slice(0, 80),
			cognitiveLoad: opts.kind === "competition" ? "heavy" : "medium",
			priority: opts.kind === "competition" ? 3 : 2,
			estimatedHours: combinedTopics.length > 0 ? sumH : 12,
			syllabusTopics: combinedTopics,
			sourceSummary: linked.linkedLabels.length > 0
				? `Pulled ${linked.linkedLabels.length} linked session/graph cluster(s): ${linked.linkedLabels.join(", ")}`
				: "No linked sessions/graph clusters selected yet.",
			pulledContext: linked.summaryText,
			modelLabel: "local:linked-context",
			usedWebSearch: false,
			trace,
		};
	}

	const combinedMaterial = [linked.summaryText, opts.materialsText?.trim()].filter(Boolean).join("\n\n");
	const resolved = opts.engineOverride
		? { role: "researcher" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("research", opts.preferredRole);
	if (opts.preferLocal || (!resolved && combinedMaterial)) {
		const parsed = parseLocalSyllabusOutline(opts.materialsText?.trim() || title);
		const topics = parsed.syllabusTopics.length > 0 && opts.materialsText?.trim() ? parsed.syllabusTopics : linked.topicHints;
		const finalTopics = topics.length > 0 ? topics : parsed.syllabusTopics;
		const sumH = Math.max(1, Math.round(finalTopics.reduce((a, t) => a + t.estHours, 0) * 10) / 10);
		pushStep({ phase: "done", message: `Parsed outline locally into ${finalTopics.length} topics (~${sumH}h).` });
		return {
			subject: (linked.resolvedSubject || title).slice(0, 80),
			cognitiveLoad: opts.kind === "competition" ? "heavy" : "medium",
			priority: opts.kind === "competition" ? 3 : 2,
			estimatedHours: sumH,
			syllabusTopics: finalTopics,
			sourceSummary: linked.linkedLabels.length > 0
				? `Parsed locally + linked (${linked.linkedLabels.join(", ")}).`
				: "Parsed outline locally (0 tokens).",
			modelLabel: "local:outline-parser",
			usedWebSearch: false,
			trace,
		};
	}
	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured in Settings -> Models to research syllabus.");
	}

	const canSearch = !opts.engineOverride && searchAvailable();
	const rawTools = canSearch ? createWebTools(() => searchProvider()) : undefined;
	const extraTools: Record<string, AgentTool<any, any>> | undefined = rawTools
		? Object.fromEntries(
			Object.entries(rawTools).map(([toolName, tool]) => {
				const origExecute = tool.execute.bind(tool) as AgentTool<any, any>["execute"];
				const wrapped: AgentTool<any, any> = {
					...tool,
					execute: async (toolCallId, params, signal, onUpdate) => {
						const p = (params ?? {}) as Record<string, unknown>;
						if (toolName === "web_search") {
							const q = typeof p?.query === "string" ? p.query : "";
							pushStep({ phase: "web_search", message: `Searching web: "${q}"` });
						} else if (toolName === "web_fetch") {
							const u = typeof p?.url === "string" ? p.url : "";
							pushStep({ phase: "web_fetch", message: `Reading webpage: ${u}`, urls: u ? [u] : undefined });
						}
						const result = await origExecute(toolCallId, params, signal, onUpdate);
						try {
							const txt =
								result && typeof result === "object" && "content" in result && Array.isArray((result as { content: unknown[] }).content)
									? ((result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join(" "))
									: String(result ?? "");
							if (toolName === "web_search") {
								const urlMatches = [...txt.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => m[0]).slice(0, 4);
								pushStep({
									phase: "web_search",
									message: `Web search returned results${urlMatches.length > 0 ? ` (${urlMatches.length} source URLs)` : ""}`,
									...(urlMatches.length > 0 ? { urls: urlMatches, detail: urlMatches.join(" · ") } : {}),
								});
							} else if (toolName === "web_fetch") {
								pushStep({
									phase: "web_fetch",
									message: `Extracted readable page content (${txt.length} chars)`,
								});
							}
						} catch {
							// Trace logging must never abort tool execution
						}
						return result;
					},
				};
				return [toolName, wrapped];
			}),
		)
		: undefined;

	pushStep({
		phase: "synthesizing",
		message: `Running ${resolved.modelLabel}${canSearch ? " with Web Search & Page Reader" : " (offline/context mode)"}...`,
	});

	const systemPrompt = `You are an Academic Competition & Exam Syllabus Estimator.
Given an exam/competition/project name (for example "Olympic Toán Giải tích Sinh viên", "ICPC Regional", "OS Midterm") and any linked Knowledge Graph / chat session context / uploaded PDF/notes, produce a realistic structured study breakdown and hour estimate, then call submit_exam_syllabus ONCE.
${canSearch ? "You have web_search and web_fetch tools: run 1-2 targeted queries ONLY if you want to verify the official syllabus/format of a specific competition or course, then submit." : "Web search is unavailable — rely on the user's linked graph/sessions, uploaded materials, and canonical syllabus structure."}
Break down into 5-10 concrete syllabus topics with realistic estHours whose sum matches estimatedHours.`;

	const promptText = [
		`Target (${opts.kind ?? "exam"}): ${title}`,
		opts.dueDate ? `Target date: ${opts.dueDate}` : null,
		combinedMaterial ? `Linked Graph / Sessions / Uploaded Materials:\n${combinedMaterial.slice(0, 6000)}` : null,
	]
		.filter(Boolean)
		.join("\n\n");

	const res = await runPlannerSubmit<{
		subject: string;
		cognitiveLoad: CognitiveLoad;
		priority: 1 | 2 | 3;
		estimatedHours: number;
		syllabusTopics: Array<{ title: string; estHours: number }>;
		sourceSummary: string;
	}>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt,
		promptText,
		toolName: "submit_exam_syllabus",
		toolDescription: "Submit the researched exam syllabus breakdown and workload hours.",
		parameters: examSyllabusSchema,
		extraTools,
		maxTurns: canSearch ? 6 : 3,
		signal: opts.signal,
		fill: (raw) => raw as {
			subject: string;
			cognitiveLoad: CognitiveLoad;
			priority: 1 | 2 | 3;
			estimatedHours: number;
			syllabusTopics: Array<{ title: string; estHours: number }>;
			sourceSummary: string;
		},
		validate: (v) => (v.subject.trim() && v.syllabusTopics.length > 0 ? null : "Include subject and syllabusTopics."),
	});

	const topics: SyllabusTopic[] = res.syllabusTopics.slice(0, 20).map((t, i) => ({
		id: `top_${Date.now()}_${i}`,
		title: t.title.trim().slice(0, 100),
		estHours: Math.max(0.5, Math.round((Number(t.estHours) || 2) * 10) / 10),
		done: false,
	}));
	const sumHours = topics.reduce((a, t) => a + t.estHours, 0);
	const estimatedHours = Math.max(1, Math.round((Number(res.estimatedHours) || sumHours) * 10) / 10);

	pushStep({
		phase: "done",
		message: `Synthesized ${topics.length} syllabus topics (~${estimatedHours}h total) via ${resolved.modelLabel}.`,
	});

	return {
		subject: res.subject.trim().slice(0, 80),
		cognitiveLoad: res.cognitiveLoad,
		priority: res.priority,
		estimatedHours,
		syllabusTopics: topics,
		sourceSummary: res.sourceSummary.trim().slice(0, 600),
		modelLabel: resolved.modelLabel,
		usedWebSearch: canSearch,
		trace,
	};
}

// ─── Personalized Workload Estimator & 24h Plan-vs-Actual Compliance Evaluator ─

const workloadEstimateSchema = Type.Object({
	estimatedHours: Type.Number(),
	recommendedDailyHours: Type.Number(),
	reasoning: Type.String(),
});

export async function estimateMilestoneWorkloadServer(
	opts: PlannerReadOptions & {
		chatsDir?: string;
		title: string;
		subject?: string;
		kind?: StudyMilestone["kind"];
		dueDate?: string;
		baseHours?: number;
		syllabusTopics?: SyllabusTopic[];
		clusterIds?: string[];
		useAi?: boolean;
		preferredRole?: ModelRole;
		engineOverride?: PiEngine;
		signal?: AbortSignal;
	},
): Promise<PersonalizedWorkloadEstimate & { modelLabel: string }> {
	const now = opts.now ?? Date.now();
	const date = localDateString(now);
	const config = readPlannerConfig(opts.plannerFile);
	const signals = buildPlannerPersonalSignals(config, { ...opts, date, now });
	const localEstimate = computePersonalizedMilestoneEstimate({
		title: opts.title,
		subject: opts.subject || opts.title,
		kind: opts.kind,
		dueDate: opts.dueDate,
		todayDate: date,
		baseHours: opts.baseHours,
		syllabusTopics: opts.syllabusTopics,
		clusterIds: opts.clusterIds,
		signals,
	});

	if (!opts.useAi) {
		return { ...localEstimate, modelLabel: "local:learning-profile" };
	}

	const resolved = opts.engineOverride
		? { role: "analyst" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("coach", opts.preferredRole);
	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured for AI workload estimation.");
	}

	const prompt = JSON.stringify({
		target: { title: opts.title, subject: opts.subject, kind: opts.kind, dueDate: opts.dueDate },
		localBaseline: localEstimate,
		learningProfile: signals.learningProfile,
	});

	const aiRes = await runPlannerSubmit<{
		estimatedHours: number;
		recommendedDailyHours: number;
		reasoning: string;
	}>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt: "Calibrate realistic study workload hours using the learner's measured FSRS retention, Practice solve rate, problem solve speed, and remaining days. Call submit_workload_estimate once.",
		promptText: prompt,
		toolName: "submit_workload_estimate",
		toolDescription: "Submit calibrated workload hours and daily study target.",
		parameters: workloadEstimateSchema,
		signal: opts.signal,
		fill: (raw) => raw as { estimatedHours: number; recommendedDailyHours: number; reasoning: string },
		validate: (v) => (Number.isFinite(v.estimatedHours) && v.estimatedHours > 0 ? null : "Invalid estimatedHours."),
	});

	return {
		...localEstimate,
		estimatedHours: Math.max(1, Math.round(aiRes.estimatedHours * 2) / 2),
		recommendedDailyHours: Math.max(0.5, Math.round(aiRes.recommendedDailyHours * 10) / 10),
		breakdownReasons: [...localEstimate.breakdownReasons, aiRes.reasoning.trim().slice(0, 260)],
		modelLabel: resolved.modelLabel,
	};
}

const journalEvaluationSchema = Type.Object({
	adherencePct: Type.Number(),
	actualStudyMin: Type.Number(),
	summary: Type.String(),
	strengths: Type.Array(Type.String()),
	frictionPoints: Type.Array(Type.String()),
	nextDayAdvice: Type.String(),
	entries: Type.Array(
		Type.Object({
			startTime: Type.String(),
			endTime: Type.String(),
			category: Type.Union([
				Type.Literal("study"),
				Type.Literal("class"),
				Type.Literal("sleep"),
				Type.Literal("meal"),
				Type.Literal("hobby"),
				Type.Literal("rest"),
				Type.Literal("distraction"),
				Type.Literal("other"),
			]),
			subject: Type.Optional(Type.String()),
			title: Type.String(),
			minutes: Type.Number(),
		}),
	),
});

export async function evaluateDailyJournalServer(
	opts: PlannerReadOptions & {
		chatsDir?: string;
		date?: string;
		journalText?: string;
		manualEntries?: JournalActivityEntry[];
		mode?: "local" | "llm";
		discreet?: boolean;
		preferredRole?: ModelRole;
		engineOverride?: PiEngine;
		signal?: AbortSignal;
	},
): Promise<{
	snapshot: PlannerSnapshotResponse;
	report: PlanComplianceReport;
	parsedEntries: JournalActivityEntry[];
	modelLabel: string;
}> {
	const now = opts.now ?? Date.now();
	const date = isValidDateString(opts.date) ? opts.date : localDateString(now);
	const filePath = opts.plannerFile ?? defaultPlannerPath();
	const current = readPlannerConfig(filePath);
	const signals = buildPlannerPersonalSignals(current, { ...opts, date, now });
	const plan = current.plans[date] ?? computeLocalPlannerPlan(current, signals, now);
	const log = current.logs[date];
	const knownSubjects = [
		...current.milestones.map((m) => m.subject),
		...plan.quotas.map((q) => q.subject),
		...signals.subjectSignals.map((s) => s.label),
	];

	const localEval = evaluatePlanVsActualLocal({
		date,
		plan,
		log,
		config: current,
		journalText: opts.journalText,
		manualEntries: opts.manualEntries,
		knownSubjects,
		now,
	});

	const discreet = opts.discreet !== false;
	const localEntries = discreet
		? localEval.parsedEntries.map((e) => ({ ...e, title: redactSensitiveJournalText(e.title) || e.title }))
		: localEval.parsedEntries;

	if ((opts.mode ?? "local") === "local") {
		const updated = applyJournalEvaluationToConfig(current, date, {
			journalText: opts.journalText,
			entries: localEntries,
			report: localEval.report,
			suggestedRealismFactor: localEval.suggestedRealismFactor,
			now,
		});
		savePlannerConfig(updated, filePath);
		return {
			snapshot: readPlannerSnapshot({ ...opts, date, now }),
			report: localEval.report,
			parsedEntries: localEntries,
			modelLabel: "local:journal-auditor",
		};
	}

	const resolved = opts.engineOverride
		? { role: "analyst" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("coach", opts.preferredRole);
	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured for AI journal evaluation.");
	}

	const journalBodyRaw = (opts.journalText ?? log?.journalText ?? "").trim();
	const journalBodyForAi = discreet ? redactSensitiveJournalText(journalBodyRaw) : journalBodyRaw;
	const entriesForAi = (opts.manualEntries ?? log?.actualEntries ?? []).map((e) => ({
		...e,
		title: discreet ? redactSensitiveJournalText(e.title) : e.title,
	}));

	const plannedStudyBlocks = plan.blocks.filter((b) => b.type === "study");
	const isToday = date === localDateString(now);
	const nowObj = new Date(now);
	const nowClockMin = nowObj.getHours() * 60 + nowObj.getMinutes();
	const lastLoggedEndMin = localEval.parsedEntries.reduce((mx, e) => {
		const m = parseClockMin(e.endTime);
		return m !== null ? Math.max(mx, m) : mx;
	}, 0);
	const cutoffMin = Math.max(isToday ? nowClockMin : 24 * 60, lastLoggedEndMin);
	const remainingPlannedBlocks = isToday ? plannedStudyBlocks.filter((b) => b.startMin >= cutoffMin) : [];
	const remainingPlannedMin = remainingPlannedBlocks.reduce((a, b) => a + b.durationMin, 0);
	const plannedSoFarMin = isToday
		? plannedStudyBlocks.filter((b) => b.startMin < cutoffMin).reduce((a, b) => a + b.durationMin, 0)
		: localEval.report.plannedStudyMin;
	const isPartialMiddayLog = isToday && cutoffMin < 20 * 60 && remainingPlannedMin >= 30;

	const prompt = JSON.stringify({
		date,
		isPartialMiddayLog,
		currentClockTime: formatClockMin(cutoffMin),
		plannedStudyHoursTotal: plan.plannedStudyHours,
		plannedSoFarMin,
		remainingPlannedStudyBlocks: remainingPlannedBlocks.map((b) => `${b.startTime}-${b.endTime} ${b.title}`),
		plannedQuotas: plan.quotas.map((q) => ({ subject: q.subject, targetMin: q.targetMin })),
		plannedBlocks: plan.blocks.map((b) => `${b.startTime}-${b.endTime} [${b.type}] ${b.title}`),
		checkedBlocksCount: log?.completedBlockIds.length ?? 0,
		manualEntries: entriesForAi,
		journalText: journalBodyForAi.slice(0, 3500),
		knownSubjects,
	});

	interface AiJournalEvalOut {
		adherencePct: number;
		actualStudyMin: number;
		summary: string;
		strengths: string[];
		frictionPoints: string[];
		nextDayAdvice: string;
		entries: Array<{
			startTime: string;
			endTime: string;
			category: JournalActivityEntry["category"];
			subject?: string;
			title: string;
			minutes: number;
		}>;
	}

	const aiOut = await runPlannerSubmit<AiJournalEvalOut>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt:
			"You are a candid, supportive Student Study Auditor. Parse the student's freeform journal against today's planned schedule, score honest adherencePct (0-100), extract structured activity entries with realistic minutes, note strengths & distractions/friction, and give concise practical advice. IMPORTANT: Keep output strictly discreet — never repeat explicit personal terms, keep any private break/reset neutral like '[Personal reset]'. If `isPartialMiddayLog` is true, score adherencePct relative to `plannedSoFarMin` (or neutral mid-day progress if no study block was due before `currentClockTime`) and NEVER treat `remainingPlannedStudyBlocks` later today as skipped failures; focus `nextDayAdvice` on finishing the remaining blocks today. Call submit_journal_evaluation once.",
		promptText: prompt,
		toolName: "submit_journal_evaluation",
		toolDescription: "Submit 24h Plan vs Actual compliance evaluation and extracted timeline.",
		parameters: journalEvaluationSchema,
		signal: opts.signal,
		fill: (raw) => raw as AiJournalEvalOut,
		validate: (v) => (v.summary?.trim() ? null : "Provide evaluation summary."),
	});

	const maskOut = (s: string) => (discreet ? redactSensitiveJournalText(s) : s);

	const aiEntries: JournalActivityEntry[] = (aiOut.entries.length > 0 ? aiOut.entries : localEval.parsedEntries).map((e, i) => ({
		id: `jai_${date}_${i}`,
		startTime: typeof e.startTime === "string" && e.startTime.trim() ? e.startTime.trim().slice(0, 8) : "08:00",
		endTime: typeof e.endTime === "string" && e.endTime.trim() ? e.endTime.trim().slice(0, 8) : "09:00",
		category: e.category,
		...(typeof e.subject === "string" && e.subject.trim() ? { subject: e.subject.trim().slice(0, 80) } : {}),
		title: maskOut(String(e.title || "Logged activity").trim()).slice(0, 140),
		minutes: Math.max(5, Math.min(720, Math.round(Number(e.minutes) || 30))),
		source: "ai_extracted",
	}));

	const plannedStudyMin = Math.max(30, localEval.report.plannedStudyMin);
	const actualStudyMin = Math.max(0, Math.min(960, Math.round(Number(aiOut.actualStudyMin) || 0)));
	const prevRealism = current.realismFactor ?? 1.0;
	const observedRealism = isPartialMiddayLog ? prevRealism : Math.max(0.4, Math.min(1.35, actualStudyMin / plannedStudyMin));
	const suggestedRealismFactor = isPartialMiddayLog
		? prevRealism
		: Math.max(0.65, Math.min(1.25, Math.round((prevRealism * 0.75 + observedRealism * 0.25) * 100) / 100));

	const report: PlanComplianceReport = {
		date,
		evaluatedAt: new Date(now).toISOString(),
		evaluatedBy: "llm",
		modelLabel: resolved.modelLabel,
		adherencePct: Math.max(0, Math.min(100, Math.round(Number(aiOut.adherencePct) || 0))),
		plannedStudyMin: localEval.report.plannedStudyMin,
		actualStudyMin,
		realismRatio: Math.round(observedRealism * 100) / 100,
		summary: maskOut(aiOut.summary.trim()).slice(0, 600),
		strengths: aiOut.strengths.slice(0, 6).map((s) => maskOut(String(s).trim()).slice(0, 180)).filter(Boolean),
		frictionPoints: aiOut.frictionPoints.slice(0, 6).map((s) => maskOut(String(s).trim()).slice(0, 180)).filter(Boolean),
		nextDayAdvice: maskOut(aiOut.nextDayAdvice.trim()).slice(0, 260),
	};

	const updated = applyJournalEvaluationToConfig(current, date, {
		journalText: opts.journalText,
		entries: aiEntries,
		report,
		suggestedRealismFactor,
		now,
	});
	savePlannerConfig(updated, filePath);

	return {
		snapshot: readPlannerSnapshot({ ...opts, date, now }),
		report,
		parsedEntries: aiEntries,
		modelLabel: resolved.modelLabel,
	};
}

// ─── 6. AI / Smart Lifestyle, Hobby, Gaming & Sleep Balance Optimizer ────────

const lifestyleSuggestionSchema = Type.Object({
	hobbies: Type.Array(Type.String()),
	dailyHobbyMin: Type.Number(),
	gameBudgetMin: Type.Number(),
	gameCutoffBeforeBedMin: Type.Number(),
	windDownBufferMin: Type.Number(),
	allowMiddayRecoveryNap: Type.Boolean(),
	postDinnerComaProtection: Type.Optional(Type.Boolean()),
	rationale: Type.String(),
	tips: Type.Array(Type.String()),
});

export async function suggestLifestyleBalanceServer(
	opts: PlannerReadOptions & {
		useAi?: boolean;
		preferredRole?: ModelRole;
		engineOverride?: PiEngine;
		signal?: AbortSignal;
	},
): Promise<{
	hobbies: string[];
	dailyHobbyMin: number;
	gameBudgetMin: number;
	gameCutoffBeforeBedMin: number;
	windDownBufferMin: number;
	allowMiddayRecoveryNap: boolean;
	postDinnerComaProtection: boolean;
	rationale: string;
	tips: string[];
	modelLabel: string;
}> {
	const now = opts.now ?? Date.now();
	const date = localDateString(now);
	const config = readPlannerConfig(opts.plannerFile);
	const band = INTENSITY_STUDY_BOUNDS[config.intensity];
	const sleep = config.lifestyle.sleep;
	const earlyWake = Boolean(sleep.earlyWakingIssue);
	const guard = config.lifestyle.wellnessGuardrail;
	const recentFoodComa = Object.values(config.logs).some((l) => Boolean(l.foodComaHitToday));
	const postDinnerShield = Boolean(sleep.postDinnerComaProtection || recentFoodComa || guard?.riskWindows?.includes("post_dinner_slump"));

	const localDailyHobby = Math.max(config.lifestyle.dailyHobbyMin, band.minHobbyMin);
	const localGame = Math.min(config.lifestyle.gameBudgetMin ?? 30, config.intensity === "healthy" ? 45 : config.intensity === "balanced" ? 30 : 20);
	const localCutoff = earlyWake ? 120 : 90;
	const localWindDown = earlyWake ? 45 : 30;
	const localTips: string[] = [
		`Keep ${localGame > 0 ? `gaming <= ${localGame}m and stop at least ${localCutoff}m` : "screens off"} before bed (${sleep.targetBedtime}).`,
		earlyWake
			? "Waking early at 4-5 AM: keep morning light exposure early, allow a 20-25m nap around 13:00 (seated or alarm across room), and avoid napping past 14:15."
			: "Protect your midday break right after lunch instead of forcing extra afternoon screen time.",
	];
	if (postDinnerShield) {
		localTips.push(
			"Post-dinner food coma (~20:00-21:00): keep dinner lighter in refined carbs, take a 15m brisk walk + cold water immediately after eating, and assign offline hobbies or light flashcards during the 20:00-21:15 dip.",
		);
	}
	if (guard?.enabled) {
		const wins = guard.riskWindows ?? ["late_night"];
		if (wins.includes("post_nap_wake") || wins.includes("early_morning_wake")) {
			localTips.push(
				`Post-nap / early-wake surge shield: prefrontal brakes lag 10-15m after waking (sleep inertia). Feet on floor <60s, phone outside bed, wash face cold water, and follow: ${guard.wakeUpAnchorProtocol || guard.replacementProtocol || "10m walk & start first desk micro-task standing"}.`,
			);
		} else {
			localTips.push(
				`Pre-commit high-risk windows (${wins.join(", ")}): replace immediately with ${guard.replacementProtocol || "10m walk, water & phone outside bedroom"}.`,
			);
		}
	}

	if (!opts.useAi) {
		return {
			hobbies: config.lifestyle.hobbies.length > 0 ? config.lifestyle.hobbies : ["Outdoor Walk / Sport", "Offline Reading"],
			dailyHobbyMin: localDailyHobby,
			gameBudgetMin: localGame,
			gameCutoffBeforeBedMin: localCutoff,
			windDownBufferMin: localWindDown,
			allowMiddayRecoveryNap: true,
			postDinnerComaProtection: postDinnerShield,
			rationale: `Calibrated for ${config.intensity} intensity${earlyWake ? " + early-waking continuity care" : ""}${postDinnerShield ? " + post-dinner coma buffer" : ""}${guard?.enabled ? " + wake/impulse transition anchors" : ""}.`,
			tips: localTips,
			modelLabel: "local:lifestyle-optimizer",
		};
	}

	const resolved = opts.engineOverride
		? { role: "prober" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("coach", opts.preferredRole);
	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured for AI lifestyle optimization.");
	}

	const recentNotes = Object.values(config.logs)
		.sort((a, b) => b.date.localeCompare(a.date))
		.slice(0, 7)
		.map((l) => ({
			date: l.date,
			slept: l.actualBedtime,
			woke: l.actualWakeTime,
			energy: l.energyScore,
			early: l.wokeEarlyUnintended,
			foodComa: l.foodComaHitToday,
			urgesSurfed: l.urgesSurfed,
			urgeTriggerWindows: l.urgeTriggerWindows,
		}));

	interface LifestyleSuggestionOut {
		hobbies: string[];
		dailyHobbyMin: number;
		gameBudgetMin: number;
		gameCutoffBeforeBedMin: number;
		windDownBufferMin: number;
		allowMiddayRecoveryNap: boolean;
		postDinnerComaProtection?: boolean;
		rationale: string;
		tips: string[];
	}

	const res = await runPlannerSubmit<LifestyleSuggestionOut>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt:
			"You are an evidence-based behavioral, circadian & metabolic study coach. Design a sustainable balance covering hobbies, bounded gaming cutoff, post-dinner food coma prevention (post-meal 15m walk, lighter 20:00-21:15 cognitive load), sleep-inertia wake/post-nap impulse stabilization (<60s feet-on-floor anchor, phone outside bed, 10-15m urge surfing delay), and early-waking consolidation. Call submit_lifestyle_balance once. Keep outward timeline advice practical, non-judgmental, and discreet.",
		promptText: JSON.stringify({
			intensity: config.intensity,
			currentLifestyle: config.lifestyle,
			recentSleepLogs: recentNotes,
		}),
		toolName: "submit_lifestyle_balance",
		toolDescription: "Submit calibrated lifestyle, food coma buffer, gaming cutoff, and sleep/impulse transition settings.",
		parameters: lifestyleSuggestionSchema,
		signal: opts.signal,
		fill: (raw) => raw as LifestyleSuggestionOut,
		validate: (v) => (v.rationale?.trim() ? null : "Provide rationale."),
	});

	return {
		hobbies: res.hobbies.slice(0, 8).map((h) => String(h).trim()).filter(Boolean),
		dailyHobbyMin: Math.max(20, Math.min(180, Math.round(res.dailyHobbyMin || localDailyHobby))),
		gameBudgetMin: Math.max(0, Math.min(120, Math.round(res.gameBudgetMin || 0))),
		gameCutoffBeforeBedMin: Math.max(45, Math.min(180, Math.round(res.gameCutoffBeforeBedMin || 90))),
		windDownBufferMin: Math.max(20, Math.min(60, Math.round(res.windDownBufferMin || 35))),
		allowMiddayRecoveryNap: Boolean(res.allowMiddayRecoveryNap),
		postDinnerComaProtection: Boolean(res.postDinnerComaProtection ?? postDinnerShield),
		rationale: res.rationale.trim().slice(0, 450),
		tips: res.tips.slice(0, 6).map((t) => String(t).trim()).filter(Boolean),
		modelLabel: resolved.modelLabel,
	};
}

// ─── 7. Scientific Cognitive & Learning Capacity Diagnostics ─────────────────

const QUIZ_RESULT_TOOLS = new Set(["quiz", "probe", "mcq", "mcq_batch", "explain", "recall"]);

function collectQuizAndPracticeSamples(opts: {
	sessions: readonly PlannerSessionSummary[];
	knownSubjects: readonly string[];
	chatsDir?: string;
}): {
	quizSamples: QuizConfidenceSample[];
	practiceSamples: PracticeOutcomeSample[];
	recallExplainCount: number;
} {
	const quizSamples: QuizConfidenceSample[] = [];
	const practiceSamples: PracticeOutcomeSample[] = [];
	let recallExplainCount = 0;

	const pushQuizDetail = (detail: Record<string, unknown>, origin: string, subject: string | undefined, sessionTitle: string) => {
		if (detail.dismissed || detail.byVoice) return;
		if (origin === "explain" || origin === "recall" || origin === "coding_question") {
			recallExplainCount++;
		}
		const dontKnow = Boolean(detail.dontKnow);
		const isGraded = detail.correct === true || detail.correct === false || dontKnow;
		if (!isGraded) return;
		const conf =
			!dontKnow && typeof detail.confidence === "number" && Number.isFinite(detail.confidence)
				? Math.max(0, Math.min(100, Math.round(detail.confidence)))
				: null;
		quizSamples.push({
			...(subject ? { subject } : {}),
			sessionTitle,
			confidencePct: conf,
			correct: detail.correct === true,
			dontKnow,
			origin,
		});
	};

	for (const s of opts.sessions) {
		const chat = readChatSafe(s.id, opts.chatsDir);
		if (!chat) continue;
		const sessionTitle = chat.title || s.title;
		const subject = matchKnownSubject(sessionTitle, opts.knownSubjects, extractFirstUserMessageText(chat));
		const msgs = Array.isArray(chat.messages) ? chat.messages : [];
		let lastProblemTs: number | null = null;
		let firstAttemptTs: number | null = null;
		const concludedCallIds = new Set<string>();

		for (const m of msgs as Array<Record<string, unknown>>) {
			const ts = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : null;
			if (m.role === "user" && lastProblemTs !== null && firstAttemptTs === null && ts !== null && ts > lastProblemTs) {
				firstAttemptTs = ts;
			}
			const content = Array.isArray(m.content) ? m.content : [];
			for (const blk of content as Array<Record<string, unknown>>) {
				if (blk.type !== "toolCall") continue;
				const callName = typeof blk.name === "string" ? blk.name : "";
				if (callName === "problem" && ts !== null) {
					lastProblemTs = ts;
					firstAttemptTs = null;
				} else if (callName === "conclude") {
					const args = (blk.arguments && typeof blk.arguments === "object" ? blk.arguments : {}) as Record<string, unknown>;
					const outcome = typeof args.outcome === "string" ? args.outcome : "";
					if (outcome === "solved" || outcome === "solvedWithHints" || outcome === "movedOn" || outcome === "surrendered") {
						if (typeof blk.id === "string" && blk.id) concludedCallIds.add(blk.id);
						const durMin = resolveProblemDurationMin(ts, lastProblemTs, firstAttemptTs);
						practiceSamples.push({
							...(subject ? { subject } : {}),
							sessionTitle,
							outcome,
							rung: typeof args.rung === "string" ? args.rung : null,
							missClass: typeof args.missClass === "string" ? args.missClass : null,
							durationMin: durMin,
						});
						lastProblemTs = null;
						firstAttemptTs = null;
					}
				}
			}

			if (m.role !== "toolResult") continue;
			const toolName = typeof m.toolName === "string" ? m.toolName : "";
			if (m.isError) continue;
			const details = m.details as Record<string, unknown> | undefined;

			if (QUIZ_RESULT_TOOLS.has(toolName) || toolName === "coding_question") {
				if (!details || typeof details !== "object") continue;
				if (Array.isArray(details.batch)) {
					for (const item of details.batch as Array<Record<string, unknown>>) {
						if (item && typeof item === "object") pushQuizDetail(item, toolName, subject, sessionTitle);
					}
				} else {
					pushQuizDetail(details, toolName, subject, sessionTitle);
				}
			} else if (toolName === "conclude") {
				const callId = typeof m.toolCallId === "string" ? m.toolCallId : "";
				if (callId && concludedCallIds.has(callId)) continue;
				if (!details || typeof details !== "object") continue;
				const outcome = typeof details.outcome === "string" ? details.outcome : "";
				if (outcome === "solved" || outcome === "solvedWithHints" || outcome === "movedOn" || outcome === "surrendered") {
					const durMin = resolveProblemDurationMin(ts, lastProblemTs, firstAttemptTs);
					practiceSamples.push({
						...(subject ? { subject } : {}),
						sessionTitle,
						outcome,
						rung: typeof details.rung === "string" ? details.rung : null,
						missClass: typeof details.missClass === "string" ? details.missClass : null,
						durationMin: durMin,
					});
					lastProblemTs = null;
					firstAttemptTs = null;
				}
			}
		}
	}

	return { quizSamples, practiceSamples, recallExplainCount };
}

export function readPlannerLearningCapacityServer(
	opts?: PlannerReadOptions & { chatsDir?: string; date?: string },
): {
	report: LearningCapacityReport;
	signals: PlannerPersonalSignals;
	config: PlannerConfig;
	aiAvailability: ReturnType<typeof getPlannerAiAvailability>;
} {
	const now = opts?.now ?? Date.now();
	const date = isValidDateString(opts?.date) ? opts!.date : localDateString(now);
	const config = readPlannerConfig(opts?.plannerFile);
	const signals = buildPlannerPersonalSignals(config, { ...opts, date, now });

	const isolatedTestMode = Boolean(opts?.plannerFile && !opts.flashcardsFile);
	let graphNodeCount = 0;
	let graphChainCount = 0;
	let graphFsrs: GraphFsrsSummary = emptyGraphFsrsSummary();
	let fsrsWeights: number[] | undefined;
	let fsrsReviewRatings: number[] = [];

	try {
		const flashcards = isolatedTestMode ? null : readFlashcardsSnapshot(opts?.flashcardsFile);
		if (flashcards) {
			if (Array.isArray(flashcards.settings?.weights)) {
				fsrsWeights = flashcards.settings.weights.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
			}
			if (Array.isArray(flashcards.reviews)) {
				fsrsReviewRatings = (flashcards.reviews as Array<Record<string, unknown>>)
					.map((r) => Number(r?.rating))
					.filter((n) => Number.isFinite(n) && n >= 1 && n <= 4);
			}
		}
		if (!isolatedTestMode) {
			const g = graphView();
			graphNodeCount = g.propositions.length;
			graphChainCount = g.chains.length;
			if (flashcards && graphNodeCount > 0) {
				graphFsrs = computeGraphFsrsSummary({ nodes: g.propositions, chains: g.chains }, flashcards, now);
			}
		}
	} catch {
		// ignore uninitialized graph/flashcards
	}

	const sessions = opts?.plannerFile && !opts.chatsDir ? [] : resolveChatsFallback(opts?.chatsDir, 40);
	const knownSubjects = [
		...signals.subjectSignals.map((s) => s.label),
		...config.milestones.map((m) => m.subject),
	];
	const { quizSamples, practiceSamples, recallExplainCount } = collectQuizAndPracticeSamples({
		sessions,
		knownSubjects,
		chatsDir: opts?.chatsDir,
	});
	const mistakes: MistakeRecord[] = opts?.mistakesFile
		? readMistakes(opts.mistakesFile)
		: isolatedTestMode
			? []
			: readMistakes();

	const report = computeLearningCapacityReport({
		config,
		signals,
		graphFsrs,
		fsrsWeights,
		fsrsReviewRatings,
		graphNodeCount,
		graphChainCount,
		quizSamples,
		practiceSamples,
		recallExplainCount,
		mistakes,
		now,
	});

	return {
		report,
		signals,
		config,
		aiAvailability: getPlannerAiAvailability(),
	};
}

export function calibratePlannerFromCapacityServer(
	opts?: PlannerReadOptions & { chatsDir?: string; date?: string },
): { snapshot: PlannerSnapshotResponse; report: LearningCapacityReport } {
	const now = opts?.now ?? Date.now();
	const date = isValidDateString(opts?.date) ? opts!.date : localDateString(now);
	const { report } = readPlannerLearningCapacityServer({ ...opts, date, now });
	const snapshot = patchPlannerConfig({ realismFactor: report.recommendedRealismFactor }, { ...opts, now });
	return { snapshot, report };
}

export interface CapacityAiDiagnosis {
	summary: string;
	strengths: string[];
	bottlenecks: string[];
	neuroProtocols: string[];
	suggestedPaceNote: string;
	modelLabel: string;
}

const capacityDiagnosisSchema = Type.Object({
	summary: Type.String(),
	strengths: Type.Array(Type.String()),
	bottlenecks: Type.Array(Type.String()),
	neuroProtocols: Type.Array(Type.String()),
	suggestedPaceNote: Type.String(),
});

export async function diagnoseLearningCapacityWithAiServer(
	opts?: PlannerReadOptions & {
		chatsDir?: string;
		date?: string;
		preferredRole?: ModelRole;
		engineOverride?: PiEngine;
		signal?: AbortSignal;
	},
): Promise<{ report: LearningCapacityReport; diagnosis: CapacityAiDiagnosis }> {
	const now = opts?.now ?? Date.now();
	const date = isValidDateString(opts?.date) ? opts!.date : localDateString(now);
	const { report, signals } = readPlannerLearningCapacityServer({ ...opts, date, now });

	const resolved = opts?.engineOverride
		? { role: "prober" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("coach", opts?.preferredRole);
	if (!resolved) {
		throw new PlannerAiUnavailable("No AI Coach model is configured (open Settings -> Models).");
	}

	interface RawCapDiag {
		summary: string;
		strengths: string[];
		bottlenecks: string[];
		neuroProtocols: string[];
		suggestedPaceNote: string;
	}

	const res = await runPlannerSubmit<RawCapDiag>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt: `You are a Cognitive Science & Learning Analytics Coach inside ChronoHarness.
Interpret the student's quantitative Learning Capacity telemetry (FSRS-6 Stability/Difficulty/Retention, Brier Metacognitive Calibration & Confidence Bias, Problem-Solving Velocity, Graph Foundation Risk, Error Taxonomy, Circadian Adherence) and call submit_capacity_diagnosis ONCE.
Be strictly honest about sample counts: never invent data. Write clearly in the primary language of the student's subjects/sessions (Vietnamese if subjects/sessions are Vietnamese).`,
		promptText: JSON.stringify({
			learningCapacityReport: report,
			mistakeRules: signals.mistakeHints?.recentRules.slice(0, 5) ?? [],
			subjectSignals: signals.subjectSignals.slice(0, 8).map((s) => ({
				label: s.label,
				readinessPct: s.readinessPct,
				dueCount: s.dueCount,
				weakCount: s.weakCount,
				untrackedCount: s.untrackedCount,
			})),
		}),
		toolName: "submit_capacity_diagnosis",
		toolDescription: "Submit cognitive science interpretation and neuro-study protocols.",
		parameters: capacityDiagnosisSchema,
		signal: opts?.signal,
		fill: (raw) => raw as RawCapDiag,
		validate: (v) => (v.summary?.trim() ? null : "Provide cognitive diagnosis summary."),
	});

	return {
		report,
		diagnosis: {
			summary: res.summary.trim().slice(0, 700),
			strengths: (res.strengths ?? []).slice(0, 4).map((s) => String(s).trim()).filter(Boolean),
			bottlenecks: (res.bottlenecks ?? []).slice(0, 4).map((s) => String(s).trim()).filter(Boolean),
			neuroProtocols: (res.neuroProtocols ?? []).slice(0, 4).map((s) => String(s).trim()).filter(Boolean),
			suggestedPaceNote: String(res.suggestedPaceNote ?? "").trim().slice(0, 260),
			modelLabel: resolved.modelLabel,
		},
	};
}

// ─── 8. Conversational AI Coach Side Chat (Auto-Patch Schedule & Routine) ────

const coachTurnSchema = Type.Object({
	reply: Type.String({ description: "Warm, concrete coaching reply citing actual user metrics, files, sleep or graph state." }),
	shouldApplyChanges: Type.Boolean({ description: "True if applying edits to today's schedule/routine, today check-in log, or persistent lifestyle/habits." }),
	changesSummary: Type.Optional(Type.String({ description: "Concise summary of applied updates." })),
	regenerateTodaySchedule: Type.Optional(Type.Boolean({ description: "Recompute today's blocks smoothly with updated settings/focus/hours." })),
	todayOverridePatch: Type.Optional(
		Type.Object({
			wakeTime: Type.Optional(Type.String({ description: "HH:MM" })),
			sleepTime: Type.Optional(Type.String({ description: "HH:MM" })),
			meals: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String(),
						startTime: Type.String(),
						durationMin: Type.Number(),
					}),
				),
			),
			focusSubjects: Type.Optional(Type.Array(Type.String())),
			studyTargetHoursOverride: Type.Optional(Type.Number()),
			note: Type.Optional(Type.String()),
			blocks: Type.Optional(
				Type.Array(
					Type.Object({
						startTime: Type.String({ description: "HH:MM" }),
						endTime: Type.String({ description: "HH:MM" }),
						type: Type.Union([
							Type.Literal("study"),
							Type.Literal("hobby"),
							Type.Literal("break"),
							Type.Literal("meal"),
							Type.Literal("fixed"),
							Type.Literal("sleep"),
						]),
						subject: Type.Optional(Type.String()),
						title: Type.String(),
						cognitiveLoad: Type.Optional(Type.Union([Type.Literal("heavy"), Type.Literal("medium"), Type.Literal("light")])),
						reason: Type.Optional(Type.String()),
						actionTopic: Type.Optional(Type.String()),
					}),
				),
			),
		}),
	),
	todayLogPatch: Type.Optional(
		Type.Object({
			energyScore: Type.Optional(Type.Number()),
			actualBedtime: Type.Optional(Type.String()),
			actualWakeTime: Type.Optional(Type.String()),
			wokeEarlyUnintended: Type.Optional(Type.Boolean()),
			foodComaHitToday: Type.Optional(Type.Boolean()),
			urgesSurfed: Type.Optional(Type.Number()),
			urgeTriggerWindows: Type.Optional(Type.Array(Type.String())),
		}),
	),
	lifestylePatch: Type.Optional(
		Type.Object({
			intensity: Type.Optional(Type.Union([Type.Literal("healthy"), Type.Literal("balanced"), Type.Literal("intensive")])),
			sleep: Type.Optional(
				Type.Object({
					currentBedtime: Type.Optional(Type.String()),
					targetBedtime: Type.Optional(Type.String()),
					targetSleepHours: Type.Optional(Type.Number()),
					shiftStepMinPerDay: Type.Optional(Type.Number()),
					peakFocusWindow: Type.Optional(
						Type.Union([Type.Literal("auto"), Type.Literal("morning"), Type.Literal("afternoon"), Type.Literal("evening")]),
					),
					earlyWakingIssue: Type.Optional(Type.Boolean()),
					preferredWakeTime: Type.Optional(Type.String()),
					windDownBufferMin: Type.Optional(Type.Number()),
					allowMiddayRecoveryNap: Type.Optional(Type.Boolean()),
					postDinnerComaProtection: Type.Optional(Type.Boolean()),
					eveningDrowsyStart: Type.Optional(Type.String()),
				}),
			),
			meals: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String(),
						startTime: Type.String(),
						durationMin: Type.Number(),
					}),
				),
			),
			hobbies: Type.Optional(Type.Array(Type.String())),
			dailyHobbyMin: Type.Optional(Type.Number()),
			gameBudgetMin: Type.Optional(Type.Number()),
			gameCutoffBeforeBedMin: Type.Optional(Type.Number()),
			wellnessGuardrail: Type.Optional(
				Type.Object({
					enabled: Type.Optional(Type.Boolean()),
					riskWindows: Type.Optional(Type.Array(Type.String())),
					replacementProtocol: Type.Optional(Type.String()),
					wakeUpAnchorProtocol: Type.Optional(Type.String()),
					cravingReframeNote: Type.Optional(Type.String()),
					deviceFrictionRules: Type.Optional(Type.Array(Type.String())),
					targetWeeklyFreq: Type.Optional(Type.Number()),
				}),
			),
			mutedSubjects: Type.Optional(Type.Array(Type.String())),
			pinnedSubjects: Type.Optional(Type.Array(Type.String())),
		}),
	),
});

interface CoachTurnOut {
	reply: string;
	shouldApplyChanges: boolean;
	changesSummary?: string;
	regenerateTodaySchedule?: boolean;
	todayOverridePatch?: {
		wakeTime?: string;
		sleepTime?: string;
		meals?: Array<{ label: string; startTime: string; durationMin: number }>;
		focusSubjects?: string[];
		studyTargetHoursOverride?: number;
		note?: string;
		blocks?: Array<{
			startTime: string;
			endTime: string;
			type: PlannedBlock["type"];
			subject?: string;
			title: string;
			cognitiveLoad?: CognitiveLoad;
			reason?: string;
			actionTopic?: string;
		}>;
	};
	todayLogPatch?: {
		energyScore?: number;
		actualBedtime?: string;
		actualWakeTime?: string;
		wokeEarlyUnintended?: boolean;
		foodComaHitToday?: boolean;
		urgesSurfed?: number;
		urgeTriggerWindows?: string[];
	};
	lifestylePatch?: {
		intensity?: PlannerIntensity;
		sleep?: Partial<LifestyleConfig["sleep"]>;
		meals?: Array<{ label: string; startTime: string; durationMin: number }>;
		hobbies?: string[];
		dailyHobbyMin?: number;
		gameBudgetMin?: number;
		gameCutoffBeforeBedMin?: number;
		wellnessGuardrail?: {
			enabled?: boolean;
			riskWindows?: string[];
			replacementProtocol?: string;
			wakeUpAnchorProtocol?: string;
			cravingReframeNote?: string;
			deviceFrictionRules?: string[];
			targetWeeklyFreq?: number;
		};
		mutedSubjects?: string[];
		pinnedSubjects?: string[];
	};
}

function buildMealsFromCoachPatch(raw: Array<{ label: string; startTime: string; durationMin: number }>): MealSlot[] {
	const out: MealSlot[] = [];
	for (let i = 0; i < raw.length && out.length < 6; i++) {
		const m = raw[i];
		if (!m || parseClockMin(m.startTime) === null) continue;
		out.push({
			id: `meal_coach_${i}_${Date.now().toString(36).slice(-4)}`,
			label: String(m.label || `Meal ${i + 1}`).trim().slice(0, 50),
			startTime: formatClockMin(parseClockMin(m.startTime)!),
			durationMin: Math.max(15, Math.min(120, Math.round(Number(m.durationMin) || 35))),
		});
	}
	return out;
}

function buildCustomBlocksFromCoach(
	raw: NonNullable<CoachTurnOut["todayOverridePatch"]>["blocks"],
	date: string,
): PlannedBlock[] {
	if (!raw || !Array.isArray(raw)) return [];
	const out: PlannedBlock[] = [];
	for (let i = 0; i < raw.length && out.length < 28; i++) {
		const b = raw[i];
		if (!b) continue;
		const s = parseClockMin(b.startTime);
		const eRaw = parseClockMin(b.endTime);
		if (s === null || eRaw === null) continue;
		const endMin = eRaw <= s ? eRaw + 1440 : eRaw;
		if (endMin - s < 5) continue;
		out.push({
			id: `coach_${date}_${i}`,
			date,
			startTime: formatClockMin(s),
			endTime: formatClockMin(endMin),
			startMin: s,
			endMin,
			durationMin: endMin - s,
			type: b.type,
			title: String(b.title || "Coach Block").trim().slice(0, 120),
			...(b.subject?.trim() ? { subject: b.subject.trim().slice(0, 80) } : {}),
			...(b.cognitiveLoad ? { cognitiveLoad: b.cognitiveLoad } : {}),
			...(b.reason?.trim() ? { reason: b.reason.trim().slice(0, 180) } : {}),
			...(b.actionTopic?.trim() ? { actionTopic: b.actionTopic.trim().slice(0, 120) } : {}),
			...(b.type === "study" ? { strictSwitch: true } : {}),
		});
	}
	return out.sort((a, b) => a.startMin - b.startMin);
}

export async function chatWithPlannerCoachServer(
	opts: PlannerReadOptions & {
		message: string;
		focusArea?: "schedule" | "lifestyle" | "general";
		preferredRole?: ModelRole;
		chatsDir?: string;
		date?: string;
		engineOverride?: PiEngine;
		signal?: AbortSignal;
	},
): Promise<{
	snapshot: PlannerSnapshotResponse;
	assistantMessage: CoachChatMessage;
	appliedChange?: CoachChatAppliedChange;
}> {
	const userText = opts.message.trim().slice(0, 2000);
	if (!userText) throw new Error("Message cannot be empty.");

	const now = opts.now ?? Date.now();
	const date = isValidDateString(opts.date) ? opts.date : localDateString(now);
	const filePath = opts.plannerFile ?? defaultPlannerPath();

	let current = readPlannerConfig(filePath);
	const { report: capacity, signals } = readPlannerLearningCapacityServer({ ...opts, date, now });
	const todayPlan = current.plans[date] ?? computeLocalPlannerPlan(current, signals, now);

	const resolved = opts.engineOverride
		? { role: "prober" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("coach", opts.preferredRole);
	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured for Coach Chat (open Settings -> Models).");
	}

	const band = INTENSITY_STUDY_BOUNDS[current.intensity];
	const existingOverride = current.dayOverrides?.[date];
	const existingLog = current.logs[date];
	const history = (current.coachChat ?? []).slice(-10).map((m) => ({
		role: m.role,
		text: m.text.slice(0, 600),
		applied: m.appliedChange?.summary,
	}));

	const digest = buildCompactPlannerDigest(current, signals, todayPlan);
	const coachContext = {
		focusArea: opts.focusArea ?? "general",
		todayDate: date,
		activePlanSummary: {
			intensity: todayPlan.intensity,
			intensityBounds: {
				minStudyHours: Number((band.minFloorMin / 60).toFixed(1)),
				softCapHours: Number((band.softCapMin / 60).toFixed(1)),
				hardCeilingHours: Number((band.hardCeilingMin / 60).toFixed(1)),
			},
			todayWakeTime: todayPlan.todayWakeTime,
			recommendedBedtime: todayPlan.recommendedBedtime,
			plannedStudyHours: todayPlan.plannedStudyHours,
			blocks: todayPlan.blocks.map((b) => ({
				startTime: b.startTime,
				endTime: b.endTime,
				type: b.type,
				subject: b.subject,
				title: b.title,
				done: existingLog?.completedBlockIds.includes(b.id) ?? false,
			})),
		},
		todayOverride: existingOverride ?? null,
		todayLog: existingLog ?? null,
		lifestyle: current.lifestyle,
		learningCapacity: {
			compositeScore: capacity.compositeScore,
			tierLabel: capacity.tierLabel,
			confidenceLevel: capacity.confidenceLevel,
			recommendedPaceFactor: capacity.recommendedPaceFactor,
			recommendedRealismFactor: capacity.recommendedRealismFactor,
			sustainableDailyHours: capacity.recommendedDailyHours,
			metacognition: capacity.metacognition,
			errorProfile: capacity.errorProfile,
			dimensions: capacity.dimensions.map((d) => ({
				title: d.title,
				score: d.score,
				metric: `${d.primaryMetric.value} ${d.primaryMetric.unit}`,
				insight: d.insight,
			})),
			subjectBreakdown: capacity.subjectBreakdown.slice(0, 8),
		},
		knowledgeAndSessionsDigest: {
			milestones: digest.milestones,
			knowledgeSignals: digest.knowledgeSignals,
			recentSessions: signals.recentSessions.slice(0, 8).map((s) => ({ title: s.title, kind: s.kind })),
			mistakeRules: signals.mistakeHints?.recentRules.slice(0, 4) ?? [],
		},
		recentSleepLogs: Object.values(current.logs)
			.sort((a, b) => b.date.localeCompare(a.date))
			.slice(0, 5)
			.map((l) => ({
				date: l.date,
				slept: l.actualBedtime,
				woke: l.actualWakeTime,
				earlyWake: l.wokeEarlyUnintended,
				energy: l.energyScore,
				foodComa: l.foodComaHitToday,
				urgesSurfed: l.urgesSurfed,
				urgeTriggerWindows: l.urgeTriggerWindows,
				adherencePct: l.compliance?.adherencePct,
			})),
		recentCoachConversation: history,
	};

	const systemPrompt = `You are a deeply informed, supportive personal Study, Sleep & Behavioral Habit Coach inside ChronoHarness.
You have the student's real Schedule, Lifestyle, FSRS-6/Knowledge Graph signals, Past Chat Sessions, Mistake rules, and Scientific Learning Capacity telemetry.
Respond naturally, calmly, non-judgmentally, and collaboratively in the student's language (Vietnamese if they write Vietnamese), and call \`submit_coach_response\` ONCE.

OPERATING RULES:
1. Direct Action When Requested: If the student describes their state today ("mệt", "dậy 4h sáng", "food coma", "buồn ngủ sau ăn tối", "lên cơn sau ngủ trưa", "bỏ bớt môn X hôm nay", "chỉnh giờ ăn", "đặt giờ ngủ 22:30", "thêm gym", "giảm game") OR asks you to tailor their routine/schedule/sleep/habits, set \`shouldApplyChanges: true\` and emit exact patches in \`todayOverridePatch\`, \`todayLogPatch\`, and/or \`lifestylePatch\`.
   - For today's wake/sleep/meals/focus/blocks: put them in \`todayOverridePatch\` and set \`regenerateTodaySchedule: true\`. Only emit \`todayOverridePatch.blocks\` when they specifically want exact block placements; otherwise omit \`blocks\` so the constraint optimizer lays out a non-overlapping schedule around TKB & meals.
   - If the student reports today's actual energy, bedtime, wake time, unintended 4-5 AM awakening, food coma hit, or surfed urge windows: also update \`todayLogPatch\`.
   - If they want persistent habit changes (target bedtime, early waking care, midday nap preference, post-dinner food coma buffer \`sleep.postDinnerComaProtection\` + \`sleep.eveningDrowsyStart\`, default meal times, hobbies, game budget/cutoff, discreet guardrails, muted/pinned subjects, intensity): update \`lifestylePatch\`.
2. Special Guidance for Food Coma & Wake/Post-Nap Urges / Unwanted Cravings:
   - **Post-dinner food coma (~20:00-21:00):** Explain briefly the postprandial glycemic/parasympathetic dip and tailor \`lifestylePatch.sleep.postDinnerComaProtection: true\`, optionally suggest shifting dinner ~30m earlier or lighter evening carbs, automatically scheduling a 15m post-meal walk & placing active/offline hobby or \`light\` tasks (flashcards/review) instead of heavy work around 20:00-21:15.
   - **Sudden post-nap / early-morning libido surges & harmful fetish cravings (urgency to act immediately):** Respond with zero shame or moralizing; distinguish sleep-inertia prefrontal lag (first 10-15m after waking when subcortical reward/arousal outpaces executive braking — different from normal physiological morning tumescence) and tolerance/novelty conditioning behind escalating fetishes. Propose and patch concrete stimulus-control + "urge surfing" defenses: enable \`wellnessGuardrail\` with \`"post_nap_wake"\`, \`"early_morning_wake"\` (and \`"post_dinner_slump"\` if coupled with evening fatigue), cap nap <= 20-25m (or seated/cross-room alarm), fill \`wakeUpAnchorProtocol\` (feet on floor <60s, cold water on face, leave bed before touching phone/laptop), \`replacementProtocol\`, \`deviceFrictionRules\`, and a supportive private \`cravingReframeNote\`. If the pattern causes severe distress, gently encourage speaking with a licensed behavioral therapist without lecturing.
3. Strictly Grounded & Discreet: Cite the student's real subjects, attached files, open chapters, FSRS/Graph metrics, or mistake rules. Never invent nonexistent metrics. If adjusting \`wellnessGuardrail\`, keep visible block titles 100% neutral and discreet.
4. Pure Questions: If they only ask a question or ask for feedback without wanting edits, set \`shouldApplyChanges: false\`.`;

	const payload = await runPlannerSubmit<CoachTurnOut>({
		role: resolved.role,
		engine: resolved.engine,
		systemPrompt,
		promptText: `Student context:\n${JSON.stringify(coachContext)}\n\nStudent's new message:\n${userText}`,
		toolName: "submit_coach_response",
		toolDescription: "Submit the conversational coaching reply and any structured schedule/routine/lifestyle edits.",
		parameters: coachTurnSchema,
		signal: opts.signal,
		fill: (raw) => raw as CoachTurnOut,
		validate: (val) => (val.reply?.trim() ? null : "Provide a non-empty reply."),
	});

	const userMsgId = `cm_u_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const aiMsgId = `cm_a_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const nowIso = new Date(now).toISOString();

	const patchLabels: string[] = [];
	let appliedChange: CoachChatAppliedChange | undefined;
	let nextConfig = current;

	if (payload.shouldApplyChanges) {
		const undoSnapshot: CoachUndoSnapshot = {
			messageId: aiMsgId,
			date,
			...(existingOverride ? { prevDayOverride: structuredClone(existingOverride) } : {}),
			hadDayOverride: Boolean(existingOverride),
			prevLifestyle: structuredClone(current.lifestyle),
			prevIntensity: current.intensity,
			...(existingLog ? { prevLog: structuredClone(existingLog) } : {}),
			hadLog: Boolean(existingLog),
			...(current.mutedSubjects ? { prevMutedSubjects: [...current.mutedSubjects] } : {}),
			...(current.pinnedSubjects ? { prevPinnedSubjects: [...current.pinnedSubjects] } : {}),
		};

		// 1. Today Log Check-In Patch
		if (payload.todayLogPatch) {
			const lp = payload.todayLogPatch;
			const energy = lp.energyScore && lp.energyScore >= 1 && lp.energyScore <= 5
				? (Math.round(lp.energyScore) as 1 | 2 | 3 | 4 | 5)
				: undefined;
			const checkPatch: HabitCheckInPatch = {
				date,
				...(energy ? { energyScore: energy } : {}),
				...(lp.actualBedtime && parseClockMin(lp.actualBedtime) !== null ? { actualBedtime: lp.actualBedtime } : {}),
				...(lp.actualWakeTime && parseClockMin(lp.actualWakeTime) !== null ? { actualWakeTime: lp.actualWakeTime } : {}),
				...(typeof lp.wokeEarlyUnintended === "boolean" ? { wokeEarlyUnintended: lp.wokeEarlyUnintended } : {}),
				...(typeof lp.foodComaHitToday === "boolean" ? { foodComaHitToday: lp.foodComaHitToday } : {}),
				...(typeof lp.urgesSurfed === "number" && Number.isFinite(lp.urgesSurfed) ? { urgesSurfed: lp.urgesSurfed } : {}),
				...(Array.isArray(lp.urgeTriggerWindows) ? { urgeTriggerWindows: lp.urgeTriggerWindows } : {}),
			};
			if (Object.keys(checkPatch).length > 1) {
				nextConfig = applyHabitCheckIn(nextConfig, checkPatch, now);
				patchLabels.push("Today check-in log");
			}
		}

		// 2. Persistent Lifestyle & Subject Focus Patch
		if (payload.lifestylePatch) {
			const lp = payload.lifestylePatch;
			const nextLifestyle: LifestyleConfig = {
				...nextConfig.lifestyle,
				sleep: {
					...nextConfig.lifestyle.sleep,
					...(lp.sleep ?? {}),
				},
				...(lp.meals && lp.meals.length > 0 ? { meals: buildMealsFromCoachPatch(lp.meals) } : {}),
				...(lp.hobbies ? { hobbies: lp.hobbies.slice(0, 10).map((h) => String(h).trim()).filter(Boolean) } : {}),
				...(lp.dailyHobbyMin !== undefined ? { dailyHobbyMin: lp.dailyHobbyMin } : {}),
				...(lp.gameBudgetMin !== undefined ? { gameBudgetMin: lp.gameBudgetMin } : {}),
				...(lp.gameCutoffBeforeBedMin !== undefined ? { gameCutoffBeforeBedMin: lp.gameCutoffBeforeBedMin } : {}),
				...(lp.wellnessGuardrail
					? {
						wellnessGuardrail: {
							enabled: lp.wellnessGuardrail.enabled ?? nextConfig.lifestyle.wellnessGuardrail?.enabled ?? false,
							riskWindows: lp.wellnessGuardrail.riskWindows ?? nextConfig.lifestyle.wellnessGuardrail?.riskWindows,
							replacementProtocol: lp.wellnessGuardrail.replacementProtocol ?? nextConfig.lifestyle.wellnessGuardrail?.replacementProtocol,
							wakeUpAnchorProtocol: lp.wellnessGuardrail.wakeUpAnchorProtocol ?? nextConfig.lifestyle.wellnessGuardrail?.wakeUpAnchorProtocol,
							cravingReframeNote: lp.wellnessGuardrail.cravingReframeNote ?? nextConfig.lifestyle.wellnessGuardrail?.cravingReframeNote,
							deviceFrictionRules: lp.wellnessGuardrail.deviceFrictionRules ?? nextConfig.lifestyle.wellnessGuardrail?.deviceFrictionRules,
							targetWeeklyFreq: lp.wellnessGuardrail.targetWeeklyFreq ?? nextConfig.lifestyle.wellnessGuardrail?.targetWeeklyFreq,
						},
					}
					: {}),
			};
			nextConfig = {
				...nextConfig,
				...(lp.intensity ? { intensity: lp.intensity } : {}),
				...(lp.mutedSubjects !== undefined ? { mutedSubjects: lp.mutedSubjects } : {}),
				...(lp.pinnedSubjects !== undefined ? { pinnedSubjects: lp.pinnedSubjects } : {}),
				lifestyle: nextLifestyle,
			};
			if (lp.intensity) patchLabels.push(`Intensity: ${lp.intensity}`);
			if (lp.sleep) patchLabels.push("Sleep habit profile");
			if (lp.meals && lp.meals.length > 0) patchLabels.push("Default meal windows");
			if (lp.hobbies || lp.dailyHobbyMin !== undefined || lp.gameBudgetMin !== undefined) patchLabels.push("Hobbies/Gaming balance");
			if (lp.wellnessGuardrail) patchLabels.push("Habit guardrails");
			if (lp.mutedSubjects !== undefined || lp.pinnedSubjects !== undefined) patchLabels.push("Subject filters");
		}

		// 3. Today DayOverride Patch
		if (payload.todayOverridePatch) {
			const op = payload.todayOverridePatch;
			const curOv: DayOverride = nextConfig.dayOverrides?.[date] ?? { date };
			const parsedBlocks = op.blocks ? buildCustomBlocksFromCoach(op.blocks, date) : [];
			const clearsAutoCustom =
				parsedBlocks.length === 0 &&
				(op.wakeTime !== undefined ||
					op.sleepTime !== undefined ||
					op.meals !== undefined ||
					op.focusSubjects !== undefined ||
					op.studyTargetHoursOverride !== undefined ||
					payload.regenerateTodaySchedule);

			const updatedOv: DayOverride = {
				...curOv,
				date,
				...(op.wakeTime && parseClockMin(op.wakeTime) !== null ? { wakeTime: formatClockMin(parseClockMin(op.wakeTime)!) } : {}),
				...(op.sleepTime && parseClockMin(op.sleepTime) !== null ? { bedTime: formatClockMin(parseClockMin(op.sleepTime)!) } : {}),
				...(op.meals && op.meals.length > 0 ? { meals: buildMealsFromCoachPatch(op.meals) } : {}),
				...(op.focusSubjects !== undefined ? { focusSubjects: op.focusSubjects } : {}),
				...(op.studyTargetHoursOverride !== undefined ? { studyTargetHoursOverride: op.studyTargetHoursOverride } : {}),
				...(op.note !== undefined ? { note: op.note } : {}),
				...(parsedBlocks.length > 0
					? { customBlocks: parsedBlocks }
					: clearsAutoCustom
						? { customBlocks: undefined }
						: {}),
			};
			nextConfig = {
				...nextConfig,
				dayOverrides: {
					...(nextConfig.dayOverrides ?? {}),
					[date]: updatedOv,
				},
			};
			if (op.wakeTime) patchLabels.push(`Wake ${op.wakeTime}`);
			if (op.sleepTime) patchLabels.push(`Sleep ${op.sleepTime}`);
			if (op.meals && op.meals.length > 0) patchLabels.push("Today meals");
			if (op.focusSubjects !== undefined) patchLabels.push(op.focusSubjects.length > 0 ? `Focus: ${op.focusSubjects.join(", ")}` : "Cleared focus filter");
			if (op.studyTargetHoursOverride !== undefined) patchLabels.push(`Target ${op.studyTargetHoursOverride}h`);
			if (parsedBlocks.length > 0) patchLabels.push(`${parsedBlocks.length} tailored blocks`);
		}

		if (patchLabels.length > 0 || payload.regenerateTodaySchedule) {
			nextConfig = sanitizePlannerConfig({
				...nextConfig,
				lastCoachUndo: undoSnapshot,
			});
			const freshSignals = buildPlannerPersonalSignals(nextConfig, { ...opts, date, now });
			const rebuiltPlan = computeLocalPlannerPlan(nextConfig, freshSignals, now);
			rebuiltPlan.coachSummary = clipPreservingLatex(payload.reply, 340);
			rebuiltPlan.modelUsed = resolved.modelLabel;
			nextConfig = {
				...nextConfig,
				plans: {
					...nextConfig.plans,
					[date]: rebuiltPlan,
				},
			};
			const summaryText =
				payload.changesSummary?.trim() ||
				(patchLabels.length > 0 ? patchLabels.join(" · ") : "Updated today's schedule");
			appliedChange = {
				id: `chg_${now.toString(36)}`,
				summary: summaryText.slice(0, 320),
				patchLabels: patchLabels.slice(0, 8),
			};
		}
	}

	const userMsg: CoachChatMessage = {
		id: userMsgId,
		role: "user",
		text: userText,
		timestamp: nowIso,
		...(opts.focusArea ? { focusArea: opts.focusArea } : {}),
	};
	const assistantMsg: CoachChatMessage = {
		id: aiMsgId,
		role: "assistant",
		text: payload.reply.trim().slice(0, 3800),
		timestamp: nowIso,
		...(opts.focusArea ? { focusArea: opts.focusArea } : {}),
		modelLabel: resolved.modelLabel,
		...(appliedChange ? { appliedChange } : {}),
	};

	const saved = savePlannerConfig(
		{
			...nextConfig,
			coachChat: [...(nextConfig.coachChat ?? []), userMsg, assistantMsg].slice(-30),
			updatedAt: nowIso,
		},
		filePath,
	);

	return {
		snapshot: readPlannerSnapshot({ ...opts, date, now }),
		assistantMessage: saved.coachChat?.at(-1) ?? assistantMsg,
		...(appliedChange ? { appliedChange } : {}),
	};
}

export function undoPlannerCoachChangeServer(
	opts?: PlannerReadOptions & { messageId?: string; chatsDir?: string; date?: string },
): { snapshot: PlannerSnapshotResponse; undone: boolean } {
	const now = opts?.now ?? Date.now();
	const filePath = opts?.plannerFile ?? defaultPlannerPath();
	const current = readPlannerConfig(filePath);
	const undo = current.lastCoachUndo;
	if (!undo || (opts?.messageId && undo.messageId !== opts.messageId)) {
		return { snapshot: readPlannerSnapshot({ ...opts, now }), undone: false };
	}

	const date = undo.date;
	const nextOverrides = { ...(current.dayOverrides ?? {}) };
	if (undo.hadDayOverride && undo.prevDayOverride) {
		nextOverrides[date] = undo.prevDayOverride;
	} else {
		delete nextOverrides[date];
	}

	const nextLogs = { ...current.logs };
	if (undo.hadLog && undo.prevLog) {
		nextLogs[date] = undo.prevLog;
	} else {
		delete nextLogs[date];
	}

	const nextChat = (current.coachChat ?? []).map((m) =>
		m.id === undo.messageId && m.appliedChange
			? { ...m, appliedChange: { ...m.appliedChange, reverted: true } }
			: m,
	);

	const restored: PlannerConfig = sanitizePlannerConfig({
		...current,
		intensity: undo.prevIntensity,
		lifestyle: undo.prevLifestyle,
		dayOverrides: nextOverrides,
		logs: nextLogs,
		...(undo.prevMutedSubjects !== undefined ? { mutedSubjects: undo.prevMutedSubjects } : {}),
		...(undo.prevPinnedSubjects !== undefined ? { pinnedSubjects: undo.prevPinnedSubjects } : {}),
		coachChat: nextChat,
		lastCoachUndo: undefined,
		updatedAt: new Date(now).toISOString(),
	});

	const signals = buildPlannerPersonalSignals(restored, { ...opts, date, now });
	const rebuilt = computeLocalPlannerPlan(restored, signals, now);
	savePlannerConfig(
		{
			...restored,
			plans: { ...restored.plans, [date]: rebuilt },
		},
		filePath,
	);

	return {
		snapshot: readPlannerSnapshot({ ...opts, date, now }),
		undone: true,
	};
}

export function clearPlannerCoachChatServer(
	opts?: PlannerReadOptions & { chatsDir?: string; date?: string },
): PlannerSnapshotResponse {
	const now = opts?.now ?? Date.now();
	const filePath = opts?.plannerFile ?? defaultPlannerPath();
	const current = readPlannerConfig(filePath);
	savePlannerConfig(
		{
			...current,
			coachChat: [],
			lastCoachUndo: undefined,
			updatedAt: new Date(now).toISOString(),
		},
		filePath,
	);
	return readPlannerSnapshot({ ...opts, now });
}

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
	computeHabitStrengthSummary,
	computeLocalPlannerPlan,
	computePersonalizedMilestoneEstimate,
	DEFAULT_PLANNER_CONFIG,
	evaluatePlanVsActualLocal,
	formatPlainMathPreview,
	isValidDateString,
	localDateString,
	normalizeSubjectKey,
	parseIcsWeeklyEvents,
	parseJournalTextLocal,
	parseLocalSyllabusOutline,
	parseSimpleWeeklyText,
	resolveActiveBlockStatus,
	sanitizePlannerConfig,
	WEEKDAYS,
	type ActiveBlockStatus,
	type CognitiveLoad,
	type DailyStudyPlan,
	type FixedWeeklyEvent,
	type HabitCheckInPatch,
	type JournalActivityEntry,
	type LlmCoachPlanPayload,
	type PersonalizedWorkloadEstimate,
	type PlanComplianceReport,
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
import type { ChatRecord } from "../core/contracts/chat.ts";
import type { PlanTree } from "../core/contracts/plan.ts";
import { parseFilePaths } from "../core/file-paths.ts";
import { computeGraphFsrsSummary, emptyGraphFsrsSummary } from "../core/fsrs-graph.ts";
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

function resolveChatsFallback(chatsDir?: string): PlannerSessionSummary[] {
	try {
		if (!chatsDir) {
			return stores.chatStore.listChats().slice(0, 14).map((c) => ({
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
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 14);
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

		const blocks = Array.isArray(m.content) ? m.content : [];
		for (const blk of blocks as Array<Record<string, unknown>>) {
			if (blk.type !== "toolCall") continue;
			const name = typeof blk.name === "string" ? blk.name : "";
			const args = (blk.arguments && typeof blk.arguments === "object" ? blk.arguments : {}) as Record<string, unknown>;
			if (name === "problem") {
				if (ts !== null) lastProblemTs = ts;
			} else if (name === "conclude") {
				const outcome = typeof args.outcome === "string" ? args.outcome : "";
				if (outcome === "solved") solvedCount++;
				else if (outcome === "solvedWithHints") hintsCount++;
				else if (outcome === "movedOn" || outcome === "surrendered") unsolvedCount++;
				if (ts !== null && lastProblemTs !== null && ts > lastProblemTs) {
					const durMin = Math.round(Math.min(ts - lastProblemTs, 90 * 60_000) / 60_000);
					if (durMin >= 2) problemDurationsMin.push(durMin);
					lastProblemTs = null;
				}
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

	const matchSubjectForTitle = (title: string): string | undefined => {
		const normTitle = normalizeSubjectKey(title);
		if (!normTitle) return undefined;
		let best: string | undefined;
		let bestLen = 0;
		for (const b of buckets.values()) {
			const bk = normalizeSubjectKey(b.subject);
			if (bk.length >= 2 && (normTitle.includes(bk) || bk.includes(normTitle)) && bk.length > bestLen) {
				best = b.subject;
				bestLen = bk.length;
			}
		}
		return best;
	};

	for (const s of sessions.slice(0, 24)) {
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

		const matchedSubj = matchSubjectForTitle(chat.title || s.title);
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

	const sufficientData = totalFsrsReviews >= 8 && (totalPracticeSessions + totalTeachSessions >= 2 || loggedStudyDays >= 2);
	const sufficiencyReason = sufficientData
		? `Calibrated from ${totalFsrsReviews} FSRS reviews · ${totalPracticeSessions + totalTeachSessions} sessions · ${loggedStudyDays} logged day(s)`
		: `Baseline only: need ≥8 FSRS reviews and ≥2 sessions or logged days (currently ${totalFsrsReviews} FSRS reviews, ${totalPracticeSessions + totalTeachSessions} sessions, ${loggedStudyDays} logged days)`;

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
		if (sufficientData && (b.fsrsReviews >= 4 || totalProb >= 2)) {
			const diffAdjust = avgDifficulty !== null ? (avgDifficulty - 5.2) * 0.045 : 0;
			const solveAdjust = practiceSolveRatePct !== null ? (72 - practiceSolveRatePct) * 0.004 : 0;
			const lapseAdjust = lapseRatePct !== null ? Math.max(0, lapseRatePct - 15) * 0.004 : 0;
			paceFactor = Math.min(1.65, Math.max(0.75, Math.round((1 + diffAdjust + solveAdjust + lapseAdjust) * 100) / 100));
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
				for (const n of memberNodes) {
					const info = fsrs.nodes[n.id];
					if (!info) continue;
					if (info.due && dueSampleNames.length < 4) dueSampleNames.push(n.name);
					if ((info.isFoundation && info.memoryBand !== "untracked" && info.retrievability !== null && info.retrievability < 0.7) && weakSampleNames.length < 4) {
						weakSampleNames.push(n.name);
					}
				}

				const needle = scope.label.toLowerCase();
				const matchingSessions = sessions.filter((s) => s.title.toLowerCase().includes(needle) || needle.includes(s.title.toLowerCase()));

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
			recentRules: examPrep.mistakeHints.recentRules.map((r) => formatPlainMathPreview(r, 170)).filter(Boolean),
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
		: resolvePlannerEngine("coach");

	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured for AI Coach (open Settings -> Models).");
	}

	const digest = buildCompactPlannerDigest(config, signals, baseline);
	const systemPrompt = `You are a disciplined, realistic Student Study Coach inside ChronoHarness.
Analyze the compact daily student digest and call submit_daily_plan ONCE.

Rules:
- Respect fixedEventsToday, meals, sleep target, and hobby recovery — NEVER overlap fixed events.
- Only allocate dynamic blocks inside the available free windows between wake and bedtime.
- Prevent single-subject obsession: interleave urgent competition/exam subjects with break gaps, putting heavy proofs/algorithms in peak focus hours and light FSRS/mistake reviews in lower-energy windows.
- Honor healthy sleep shift (${baseline.sleepShiftAdvice}).
- Match user language (if subject/milestone titles are Vietnamese, write coachSummary/checklist cleanly in Vietnamese).
- Keep output concise: max 10 study/break/hobby blocks, max 5 quotas.`;

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

	if ((opts.mode ?? "local") === "local") {
		const updated = applyJournalEvaluationToConfig(current, date, {
			journalText: opts.journalText,
			entries: localEval.parsedEntries,
			report: localEval.report,
			suggestedRealismFactor: localEval.suggestedRealismFactor,
			now,
		});
		savePlannerConfig(updated, filePath);
		return {
			snapshot: readPlannerSnapshot({ ...opts, date, now }),
			report: localEval.report,
			parsedEntries: localEval.parsedEntries,
			modelLabel: "local:journal-auditor",
		};
	}

	const resolved = opts.engineOverride
		? { role: "analyst" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("coach", opts.preferredRole);
	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured for AI journal evaluation.");
	}

	const journalBody = (opts.journalText ?? log?.journalText ?? "").trim();
	const prompt = JSON.stringify({
		date,
		plannedStudyHours: plan.plannedStudyHours,
		plannedQuotas: plan.quotas.map((q) => ({ subject: q.subject, targetMin: q.targetMin })),
		plannedBlocks: plan.blocks.map((b) => `${b.startTime}-${b.endTime} [${b.type}] ${b.title}`),
		checkedBlocksCount: log?.completedBlockIds.length ?? 0,
		manualEntries: opts.manualEntries ?? log?.actualEntries ?? [],
		journalText: journalBody.slice(0, 3500),
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
		systemPrompt: "You are a candid Student Study Auditor. Parse the student's 24h freeform journal against today's planned schedule, score honest adherencePct (0-100), extract structured activity entries with realistic minutes, note strengths & distractions/friction, and give concise next-day adjustment advice. Call submit_journal_evaluation once.",
		promptText: prompt,
		toolName: "submit_journal_evaluation",
		toolDescription: "Submit 24h Plan vs Actual compliance evaluation and extracted timeline.",
		parameters: journalEvaluationSchema,
		signal: opts.signal,
		fill: (raw) => raw as AiJournalEvalOut,
		validate: (v) => (v.summary?.trim() ? null : "Provide evaluation summary."),
	});

	const aiEntries: JournalActivityEntry[] = (aiOut.entries.length > 0 ? aiOut.entries : localEval.parsedEntries).map((e, i) => ({
		id: `jai_${date}_${i}`,
		startTime: typeof e.startTime === "string" && e.startTime.trim() ? e.startTime.trim().slice(0, 8) : "08:00",
		endTime: typeof e.endTime === "string" && e.endTime.trim() ? e.endTime.trim().slice(0, 8) : "09:00",
		category: e.category,
		...(typeof e.subject === "string" && e.subject.trim() ? { subject: e.subject.trim().slice(0, 80) } : {}),
		title: String(e.title || "Logged activity").trim().slice(0, 140),
		minutes: Math.max(5, Math.min(720, Math.round(Number(e.minutes) || 30))),
		source: "ai_extracted",
	}));

	const plannedStudyMin = Math.max(30, localEval.report.plannedStudyMin);
	const actualStudyMin = Math.max(0, Math.min(960, Math.round(Number(aiOut.actualStudyMin) || 0)));
	const observedRealism = Math.max(0.4, Math.min(1.35, actualStudyMin / plannedStudyMin));
	const prevRealism = current.realismFactor ?? 1.0;
	const suggestedRealismFactor = Math.max(0.65, Math.min(1.25, Math.round((prevRealism * 0.75 + observedRealism * 0.25) * 100) / 100));

	const report: PlanComplianceReport = {
		date,
		evaluatedAt: new Date(now).toISOString(),
		evaluatedBy: "llm",
		modelLabel: resolved.modelLabel,
		adherencePct: Math.max(0, Math.min(100, Math.round(Number(aiOut.adherencePct) || 0))),
		plannedStudyMin: localEval.report.plannedStudyMin,
		actualStudyMin,
		realismRatio: Math.round(observedRealism * 100) / 100,
		summary: aiOut.summary.trim().slice(0, 600),
		strengths: aiOut.strengths.slice(0, 6).map((s) => String(s).trim().slice(0, 180)).filter(Boolean),
		frictionPoints: aiOut.frictionPoints.slice(0, 6).map((s) => String(s).trim().slice(0, 180)).filter(Boolean),
		nextDayAdvice: aiOut.nextDayAdvice.trim().slice(0, 260),
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

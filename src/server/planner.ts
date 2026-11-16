import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelRole } from "../../config.ts";
import { PATHS } from "../../config.ts";
import {
	applyHabitCheckIn,
	applyLlmPlanOutput,
	buildCompactPlannerDigest,
	computeHabitStrengthSummary,
	computeLocalPlannerPlan,
	DEFAULT_PLANNER_CONFIG,
	isValidDateString,
	localDateString,
	parseIcsWeeklyEvents,
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
	type LlmCoachPlanPayload,
	type PlannerConfig,
	type PlannerEngineMode,
	type PlannerIntensity,
	type PlannerPersonalSignals,
	type PlannerSessionSummary,
	type PlannerSubjectSignal,
	type StudyMilestone,
	type SyllabusTopic,
} from "../core/planner.ts";
import { computeGraphFsrsSummary, emptyGraphFsrsSummary } from "../core/fsrs-graph.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { emit } from "../core/events.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { healToolRecord } from "../agent/tools/heal.ts";
import { invalidInputResult, toToolResult } from "../agent/tool-execute.ts";
import { createWebTools } from "../agent/tools/web.ts";
import { healEncodedArguments } from "../core/argument-heal.ts";
import { providerKeyPresent } from "./keys.ts";
import { readExamPrepStatus } from "./exam-prep.ts";
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
	try {
		const isolatedTestMode = Boolean(opts?.plannerFile && !opts.flashcardsFile);
		const graph = isolatedTestMode ? { propositions: [], chains: [], clusters: [], sessions: {} } : graphView();
		const flashcards = isolatedTestMode ? null : readFlashcardsSnapshot(opts?.flashcardsFile);

		if (graph.propositions.length > 0 && examPrep.availableScopes.length > 0) {
			const nodesById = new Map(graph.propositions.map((n) => [n.id, n]));
			const clusterLookup = new Map((graph.clusters ?? []).map((c) => [c.id, c]));
			const birthLookup = new Map(birthSessionPartition(graph.propositions).map((c) => [c.id, c.members]));

			for (const scope of examPrep.availableScopes) {
				const explicitCluster = clusterLookup.get(scope.id);
				const memberIds = explicitCluster?.members ?? birthLookup.get(scope.id) ?? [];
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

	return {
		date,
		examPrep,
		subjectSignals,
		mistakeHints: examPrep.mistakeHints,
		recentSessions: sessions,
		autoTrackedStudyMinBySubject,
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
	};
}

interface ResolvedPlannerEngine {
	role: ModelRole;
	modelLabel: string;
	engine: PiEngine;
}

export function resolvePlannerEngine(kind: "coach" | "vision" | "research"): ResolvedPlannerEngine | null {
	const settings = stores.settingsStore.readSettings();
	const roleOrder: ModelRole[] =
		kind === "vision"
			? ["visualMaker", "pdfReader", "prober", "researcher", "analyst"]
			: kind === "research"
				? ["researcher", "prober", "analyst"]
				: ["prober", "sideQuestion", "researcher", "analyst"];

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
	};
}

export function readPlannerSnapshot(opts?: PlannerReadOptions & { chatsDir?: string; date?: string }): PlannerSnapshotResponse {
	const now = opts?.now ?? Date.now();
	const date = isValidDateString(opts?.date) ? opts!.date : localDateString(now);
	const filePath = opts?.plannerFile ?? defaultPlannerPath();
	let config = readPlannerConfig(filePath);
	const signals = buildPlannerPersonalSignals(config, { ...opts, date, now });

	// Use saved LLM/local plan for `date` if already generated, else compute fast 0-token local plan
	let plan = config.plans[date];
	if (!plan) {
		plan = computeLocalPlannerPlan(config, signals, now);
		config = savePlannerConfig(
			{
				...config,
				plans: { ...config.plans, [date]: plan },
			},
			filePath,
		);
	} else if (!plan.habitStrength) {
		plan = {
			...plan,
			habitStrength: computeHabitStrengthSummary(config, date),
		};
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

	const next: PlannerConfig = sanitizePlannerConfig({
		...current,
		...(patch.engineMode !== undefined ? { engineMode: patch.engineMode } : {}),
		...(patch.intensity !== undefined ? { intensity: patch.intensity } : {}),
		...(patch.fixedEvents !== undefined ? { fixedEvents: patch.fixedEvents } : {}),
		...(patch.milestones !== undefined ? { milestones: patch.milestones } : {}),
		...(patch.lifestyle !== undefined ? { lifestyle: patch.lifestyle } : {}),
		updatedAt: new Date(now).toISOString(),
	});

	const signals = buildPlannerPersonalSignals(next, { ...opts, date, now });
	const scheduleInputsChanged =
		patch.intensity !== undefined ||
		patch.fixedEvents !== undefined ||
		patch.milestones !== undefined ||
		patch.lifestyle !== undefined;

	if (scheduleInputsChanged || !next.plans[date]) {
		const freshLocal = computeLocalPlannerPlan(next, signals, now);
		next.plans = { ...next.plans, [date]: freshLocal };
	}

	const saved = savePlannerConfig(next, filePath);
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

export async function researchExamSyllabus(opts: {
	title: string;
	kind?: StudyMilestone["kind"];
	dueDate?: string;
	materialsText?: string;
	preferLocal?: boolean;
	engineOverride?: PiEngine;
	signal?: AbortSignal;
}): Promise<{
	subject: string;
	cognitiveLoad: CognitiveLoad;
	priority: 1 | 2 | 3;
	estimatedHours: number;
	syllabusTopics: SyllabusTopic[];
	sourceSummary: string;
	modelLabel: string;
	usedWebSearch: boolean;
}> {
	const title = opts.title.trim();
	if (!title) throw new Error("Exam or competition title is required.");

	const resolved = opts.engineOverride
		? { role: "researcher" as ModelRole, modelLabel: "custom", engine: opts.engineOverride }
		: resolvePlannerEngine("research");
	if (opts.preferLocal || (!resolved && opts.materialsText?.trim())) {
		const parsed = parseLocalSyllabusOutline(opts.materialsText?.trim() || title);
		return {
			subject: title.slice(0, 80),
			cognitiveLoad: opts.kind === "competition" ? "heavy" : "medium",
			priority: opts.kind === "competition" ? 3 : 2,
			estimatedHours: parsed.estimatedHours,
			syllabusTopics: parsed.syllabusTopics,
			sourceSummary: "Parsed outline locally (0 tokens).",
			modelLabel: "local:outline-parser",
			usedWebSearch: false,
		};
	}
	if (!resolved) {
		throw new PlannerAiUnavailable("No model is configured in Settings -> Models to research syllabus.");
	}

	const canSearch = !opts.engineOverride && searchAvailable();
	const extraTools = canSearch ? createWebTools(() => searchProvider()) : undefined;

	const systemPrompt = `You are an Academic Competition & Exam Syllabus Estimator.
Given an exam/competition/project name (for example "Olympic Toán Giải tích Sinh viên", "ICPC Regional", "OS Midterm") and optional student notes/materials, produce a realistic structured study breakdown and hour estimate, then call submit_exam_syllabus ONCE.
${canSearch ? "You have web_search and web_fetch tools: run 1-2 targeted queries ONLY if you want to verify the official syllabus/format of a specific competition or course, then submit." : "Web search is unavailable — rely on the user's provided material text and well-established canonical syllabus structure."}
Break down into 5-10 concrete syllabus topics with realistic estHours whose sum matches estimatedHours.`;

	const promptText = [
		`Target (${opts.kind ?? "exam"}): ${title}`,
		opts.dueDate ? `Target date: ${opts.dueDate}` : null,
		opts.materialsText?.trim() ? `Student material / outline:\n${opts.materialsText.trim().slice(0, 4000)}` : null,
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

	return {
		subject: res.subject.trim().slice(0, 80),
		cognitiveLoad: res.cognitiveLoad,
		priority: res.priority,
		estimatedHours: Math.max(1, Math.round((Number(res.estimatedHours) || sumHours) * 10) / 10),
		syllabusTopics: topics,
		sourceSummary: res.sourceSummary.trim().slice(0, 600),
		modelLabel: resolved.modelLabel,
		usedWebSearch: canSearch,
	};
}

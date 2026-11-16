import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import { titleFromPrompt, type ChatRecord } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import type { ExamPrepPatch, ExamPrepStatus } from "../core/exam-prep.ts";
import { quoteFilePath } from "../core/file-paths.ts";
import {
	activeProblemOf,
	danglingQuestionOf,
	failedOutputCallIds,
	newGraphContextMessage,
	newUserMessage,
	userFacingTextOf,
} from "../core/native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "../core/pending.ts";
import { readPluginProblemSubmission } from "../core/plugin-problems.ts";
import { readPluginQuestionAnswer, readPluginQuestionCancellation } from "../core/plugin-questions.ts";
import type { GraphStore } from "../core/ports.ts";
import {
	buildAnswer,
	normalizeOptions,
	resolveCorrect,
	seededRandom,
	shuffleOptions,
	type AnswerRequest,
	type QuestionData,
	type QuizOption,
} from "../core/question-core.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { readExamPrepStatus, writeExamPrepConfig } from "./exam-prep.ts";
import { checkInPlannerHabit, evaluateDailyJournalServer, patchPlannerConfig, readPlannerSnapshot } from "./planner.ts";
import {
	daysBetweenDates,
	type DailyHabitLog,
	type DailyStudyPlan,
	type HabitCheckInPatch,
	type MealSlot,
	type PlannerIntensity,
} from "../core/planner.ts";
import { graphView } from "./graph.ts";
import { defaultFlashcardsStorePath, loadFlashcardsScheduler, readFlashcardsSnapshot } from "./graph-fsrs.ts";
import { effectiveSettings, stores } from "./stores.ts";

export interface MobileCompanionDueCard {
	propositionId: string;
	cueId: string;
	propositionName: string;
	statement: string;
	question: string;
	answer: string;
	state: number;
	isDue: boolean;
	retrievability: number;
	stability: number;
	difficulty: number;
	intervals: Record<"1" | "2" | "3" | "4", string>;
}

export interface MobileCompanionSessionItem {
	id: string;
	title: string;
	mode: string;
	pinned?: boolean;
	updatedAt: string;
	messageCount: number;
	lastAssistantSnippet: string;
}

export interface MobileCompanionMessageItem {
	id: string;
	role: "user" | "assistant";
	text: string;
	timestamp?: number;
}

export interface MobilePendingQuestion {
	toolCallId: string;
	tool: string;
	kind: "quiz" | "ask" | "explain";
	question: string;
	multiSelect: boolean;
	options: Array<{ label: string; value: string; description?: string }>;
}

export interface MobileCompanionSessionDetail {
	id: string;
	title: string;
	mode: "teach" | "practice";
	notes: string;
	busy: boolean;
	pendingQuestionPrompt: string | null;
	pendingQuestion?: MobilePendingQuestion | null;
	messageCount: number;
	messages: MobileCompanionMessageItem[];
}

export interface MobileCompanionPlannerView {
	date: string;
	engineUsed: "local" | "llm";
	intensity: string;
	minDailyStudyHours: number;
	plannedStudyHours: number;
	freeHoursTotal: number;
	recommendedBedtime: string;
	todayWakeTime: string;
	sleepShiftAdvice: string;
	realismFactor: number;
	meals: MealSlot[];
	hobbies: string[];
	todayLog: DailyHabitLog | null;
	quotas: DailyStudyPlan["quotas"];
	blocks: DailyStudyPlan["blocks"];
	upcomingMilestones: Array<{ id: string; kind: string; title: string; dueDate: string; daysLeft: number }>;
	resetProtocol?: {
		wakeAnchor: string;
		replacement: string;
		reframeNote: string;
		postDinnerShield: boolean;
		deviceRules: string[];
	};
}

export interface MobilePlannerCheckInRequest extends HabitCheckInPatch {
	intensity?: PlannerIntensity;
	evaluateJournal?: boolean;
	taskNote?: string;
}

export interface MobileCompanionState {
	dueCards: MobileCompanionDueCard[];
	totalDue: number;
	totalTracked: number;
	examPrep: ExamPrepStatus;
	planner: MobileCompanionPlannerView;
	recentSessions: MobileCompanionSessionItem[];
}

export interface MobileCompanionOptions {
	flashcardsFile?: string;
	examPrepFile?: string;
	plannerFile?: string;
	chatsDir?: string;
	attachmentsDir?: string;
	graphStore?: GraphStore;
	now?: number;
}

interface StoredCue {
	id: string;
	question: string;
	answer: string;
	deleted?: boolean;
	latestRating?: number | null;
	lastReviewedAt?: number | null;
}

interface StoredSchedule {
	state: number;
	due: number;
	dueDay?: string;
	stability: number;
	difficulty: number;
	elapsed_days?: number;
	scheduled_days?: number;
	reps?: number;
	lapses?: number;
	learning_steps?: number;
	last_review?: number | null;
}

interface StoredProposition {
	id?: string;
	name?: string;
	statement?: string;
	snapshot?: { name?: string; statement?: string };
	cues?: StoredCue[];
	schedule?: StoredSchedule;
	firstReviewedAt?: number | null;
	learningCueId?: string | null;
	version?: number;
}

interface StoredDeck {
	id: string;
	propositionIds?: string[];
}

interface StoredFlashcardsFile {
	version?: number;
	revision?: number;
	settings?: Record<string, unknown> & { dayStart?: number };
	decks?: StoredDeck[];
	propositions?: Record<string, StoredProposition>;
	reviews?: unknown[];
}

export class MobileCompanionError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.name = "MobileCompanionError";
		this.status = status;
	}
}

function readFlashcardsStore(file: string): StoredFlashcardsFile | null {
	const snap = readFlashcardsSnapshot(file);
	if (!snap || !snap.propositions || Object.keys(snap.propositions).length === 0) {
		// Re-check existence in case store file was missing vs empty valid JSON.
		try {
			if (!fs.existsSync(/* turbopackIgnore: true */ file)) return null;
		} catch {
			return null;
		}
	}
	return snap as unknown as StoredFlashcardsFile | null;
}

function formatIntervalLabel(
	previewSchedule: { state?: number; due?: number; scheduled_days?: number },
	nowMs: number,
): string {
	if (previewSchedule.state === 2 && typeof previewSchedule.scheduled_days === "number") {
		const days = Math.max(1, Math.round(previewSchedule.scheduled_days));
		if (days >= 365) return `${Math.max(1, Math.round(days / 365))}y`;
		if (days >= 30) return `${Math.max(1, Math.round(days / 30))}mo`;
		return `${days}d`;
	}
	const due = typeof previewSchedule.due === "number" ? previewSchedule.due : nowMs + 60_000;
	const mins = Math.max(1, Math.round((due - nowMs) / 60_000));
	if (mins >= 60 * 24) return `${Math.max(1, Math.round(mins / (60 * 24)))}d`;
	if (mins >= 60) return `${Math.max(1, Math.round(mins / 60))}h`;
	return `${mins}m`;
}

/**
 * Fast recent-session reader: stats files by mtime first and parses only the newest records,
 * skipping archived sessions so multi-year desktop histories never stall Mobile Companion.
 */
function readRecentSessions(chatsDir = PATHS.chats, limit = 10): MobileCompanionSessionItem[] {
	try {
		if (!fs.existsSync(/* turbopackIgnore: true */ chatsDir)) return [];
		const fileEntries: Array<{ file: string; mtimeMs: number }> = [];
		for (const file of fs.readdirSync(/* turbopackIgnore: true */ chatsDir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const st = fs.statSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ chatsDir, file));
				fileEntries.push({ file, mtimeMs: st.mtimeMs });
			} catch {
				// Ignore transient/unreadable stat
			}
		}
		fileEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

		const items: MobileCompanionSessionItem[] = [];
		// Read up to 24 newest files so archived records don't starve the active list.
		for (const entry of fileEntries.slice(0, 24)) {
			try {
				const raw = fs.readFileSync(path.join(/* turbopackIgnore: true */ chatsDir, entry.file), "utf8");
				const record = JSON.parse(raw) as ChatRecord;
				if (!record || typeof record !== "object" || !Array.isArray(record.messages)) continue;
				if (record.archived) continue;
				let snippet = "";
				for (let i = record.messages.length - 1; i >= 0; i--) {
					const msg = record.messages[i];
					if (!msg || msg.role !== "assistant") continue;
					const texts = userFacingTextOf(msg.content);
					if (texts.length > 0) {
						const joined = texts.join("\n").replace(/\s+/g, " ").trim();
						snippet = joined.length > 220 ? `${joined.slice(0, 217)}...` : joined;
						break;
					}
				}
				items.push({
					id: record.id || entry.file.slice(0, -5),
					title: record.title || "Untitled session",
					mode: record.kind === "practice" ? "practice" : "teach",
					...(record.pinned ? { pinned: true } : {}),
					updatedAt: typeof record.updatedAt === "string"
						? record.updatedAt
						: new Date(entry.mtimeMs).toISOString(),
					messageCount: record.messages.length,
					lastAssistantSnippet: snippet,
				});
			} catch {
				// Ignore unreadable/corrupt individual chat records
			}
		}
		items.sort((a, b) => {
			const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
			return pinDiff !== 0 ? pinDiff : b.updatedAt.localeCompare(a.updatedAt);
		});
		return items.slice(0, limit);
	} catch {
		return [];
	}
}

export function buildMobileCompanionPlannerView(opts: MobileCompanionOptions = {}): MobileCompanionPlannerView {
	const now = opts.now ?? Date.now();
	const resolvedPlannerFile =
		opts.plannerFile ??
		(opts.examPrepFile ? path.join(path.dirname(opts.examPrepFile), "planner.json") : undefined);
	const snap = readPlannerSnapshot({
		plannerFile: resolvedPlannerFile,
		examPrepFile: opts.examPrepFile,
		flashcardsFile: opts.flashcardsFile,
		chatsDir: opts.chatsDir,
		now,
	});
	const todayLog = snap.config.logs[snap.plan.date] ?? null;
	const upcomingMilestones = [...snap.config.milestones]
		.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
		.slice(0, 6)
		.map((m) => ({
			id: m.id,
			kind: m.kind,
			title: m.title,
			dueDate: m.dueDate,
			daysLeft: daysBetweenDates(snap.plan.date, m.dueDate),
		}));
	return {
		date: snap.plan.date,
		engineUsed: snap.plan.engineUsed,
		intensity: snap.plan.intensity,
		minDailyStudyHours: snap.plan.minDailyStudyHours,
		plannedStudyHours: snap.plan.plannedStudyHours,
		freeHoursTotal: snap.plan.freeHoursTotal,
		recommendedBedtime: snap.plan.recommendedBedtime,
		todayWakeTime: snap.plan.todayWakeTime,
		sleepShiftAdvice: snap.plan.sleepShiftAdvice,
		realismFactor: snap.config.realismFactor ?? snap.plan.realismApplied ?? 1,
		meals: snap.config.lifestyle.meals,
		hobbies: snap.config.lifestyle.hobbies,
		todayLog,
		quotas: snap.plan.quotas,
		blocks: snap.plan.blocks,
		upcomingMilestones,
		resetProtocol: {
			wakeAnchor:
				snap.config.lifestyle.wellnessGuardrail?.wakeUpAnchorProtocol ||
				"Feet on floor <60s, cold water on face, step out of bed before screens",
			replacement:
				snap.config.lifestyle.wellnessGuardrail?.replacementProtocol ||
				"10m brisk walk, cold water, offline book, phone outside bedroom",
			reframeNote:
				snap.config.lifestyle.wellnessGuardrail?.cravingReframeNote ||
				"Peak arousal/impulse fades within 10-15m once prefrontal focus wakes up.",
			postDinnerShield: Boolean(snap.config.lifestyle.sleep.postDinnerComaProtection),
			deviceRules: snap.config.lifestyle.wellnessGuardrail?.deviceFrictionRules ?? [],
		},
	};
}

function hasDirectHabitPatchFields(patch: HabitCheckInPatch): boolean {
	return (
		patch.toggleBlockId !== undefined ||
		patch.toggleChecklistId !== undefined ||
		patch.addStudyMin !== undefined ||
		patch.actualBedtime !== undefined ||
		patch.actualWakeTime !== undefined ||
		patch.sleepQuality !== undefined ||
		patch.wokeEarlyUnintended !== undefined ||
		patch.energyScore !== undefined ||
		patch.foodComaHitToday !== undefined ||
		patch.urgesSurfed !== undefined ||
		patch.incrementUrgesSurfed !== undefined ||
		patch.urgeTriggerWindows !== undefined ||
		patch.addUrgeTrigger !== undefined ||
		patch.hobbyDone !== undefined ||
		patch.mealsOk !== undefined ||
		patch.sleepOnTarget !== undefined ||
		patch.note !== undefined ||
		patch.journalText !== undefined ||
		patch.actualEntries !== undefined
	);
}

export async function updateMobileCompanionPlannerCheckIn(
	patch: MobilePlannerCheckInRequest,
	opts: MobileCompanionOptions = {},
): Promise<{ ok: boolean; planner: MobileCompanionPlannerView }> {
	const resolvedPlannerFile =
		opts.plannerFile ??
		(opts.examPrepFile ? path.join(path.dirname(opts.examPrepFile), "planner.json") : undefined);
	const plannerOpts = {
		plannerFile: resolvedPlannerFile,
		examPrepFile: opts.examPrepFile,
		flashcardsFile: opts.flashcardsFile,
		chatsDir: opts.chatsDir,
		now: opts.now,
	};
	if (patch.intensity && (patch.intensity === "healthy" || patch.intensity === "balanced" || patch.intensity === "intensive")) {
		patchPlannerConfig({ intensity: patch.intensity }, plannerOpts);
	}
	const { intensity: _intensity, evaluateJournal, taskNote, ...habitPatch } = patch;
	const cleanedTaskNote = typeof taskNote === "string" ? taskNote.trim().slice(0, 240) : "";
	if (cleanedTaskNote && habitPatch.journalText === undefined && !evaluateJournal) {
		const before = readPlannerSnapshot(plannerOpts);
		const targetDate = habitPatch.date ?? before.plan.date;
		const existingJournal = (before.config.logs[targetDate]?.journalText ?? "").trim();
		const prefix = habitPatch.addStudyMin?.subject
			? `[+${Math.max(1, Math.round(habitPatch.addStudyMin.minutes || 15))}m ${habitPatch.addStudyMin.subject}] `
			: "";
		const line = `${prefix}${cleanedTaskNote}`;
		habitPatch.journalText = existingJournal ? `${existingJournal}\n${line}` : line;
	}
	if (evaluateJournal) {
		if (hasDirectHabitPatchFields({ ...habitPatch, journalText: undefined })) {
			const { journalText: _jt, ...habitWithoutJournal } = habitPatch;
			checkInPlannerHabit(habitWithoutJournal, plannerOpts);
		}
		await evaluateDailyJournalServer({
			...plannerOpts,
			date: habitPatch.date,
			journalText: habitPatch.journalText,
			manualEntries: habitPatch.actualEntries,
			mode: "local",
		});
		emit("planner-changed", {});
	} else if (hasDirectHabitPatchFields(habitPatch)) {
		checkInPlannerHabit(habitPatch, plannerOpts);
	}
	return { ok: true, planner: buildMobileCompanionPlannerView(opts) };
}

export function getMobileCompanionState(opts: MobileCompanionOptions = {}): MobileCompanionState {
	const now = opts.now ?? Date.now();
	const flashcardsFile = opts.flashcardsFile ?? defaultFlashcardsStorePath();
	const examPrep = readExamPrepStatus(
		opts.graphStore
			? {
				graphStore: opts.graphStore,
				examPrepFile: opts.examPrepFile,
				flashcardsFile,
				now,
			}
			: {
				examPrepFile: opts.examPrepFile,
				flashcardsFile,
				now,
			},
	);
	const recentSessions = readRecentSessions(opts.chatsDir ?? PATHS.chats);
	const planner = buildMobileCompanionPlannerView(opts);

	const store = readFlashcardsStore(flashcardsFile);
	if (!store || !store.propositions || typeof store.propositions !== "object") {
		return {
			dueCards: [],
			totalDue: 0,
			totalTracked: 0,
			examPrep,
			planner,
			recentSessions,
		};
	}

	const nodeLookup = new Map<string, { name: string; statement: string }>();
	const resolvedGraphStore = opts.graphStore ?? stores.graphStore;
	if (resolvedGraphStore) {
		try {
			for (const node of resolvedGraphStore.readNodes()) {
				nodeLookup.set(node.id, { name: node.name, statement: node.statement });
			}
		} catch {
			// Ignore if store unavailable in test
		}
	}

	const prioritySet = new Set(examPrep.priorityPropositionIds ?? []);
	const scheduler = loadFlashcardsScheduler();
	const settings = store.settings ?? {};
	const dayStart = typeof settings.dayStart === "number" ? settings.dayStart : 4;

	const dueList: MobileCompanionDueCard[] = [];
	const newList: MobileCompanionDueCard[] = [];
	let totalTracked = 0;

	for (const [key, prop] of Object.entries(store.propositions)) {
		if (!prop || typeof prop !== "object" || !prop.schedule) continue;
		const propositionId = prop.id ?? key;
		const activeCues = Array.isArray(prop.cues) ? prop.cues.filter((c) => c && !c.deleted) : [];
		if (activeCues.length === 0) continue;
		totalTracked++;

		const schedule = prop.schedule;
		const cardIsDue = schedule.state !== 0 && scheduler.isDue(schedule as unknown as Record<string, unknown>, now, dayStart);
		const cardIsNew = schedule.state === 0;
		if (!cardIsDue && !cardIsNew) continue;

		const pinned =
			(schedule.state === 1 || schedule.state === 3) && prop.learningCueId
				? activeCues.find((c) => c.id === prop.learningCueId)
				: undefined;
		const chosen = pinned ?? scheduler.chooseCue(activeCues) ?? activeCues[0]!;
		const previews = scheduler.preview(schedule as unknown as Record<string, unknown>, now, settings);
		const graphNode = nodeLookup.get(propositionId);
		const retrievability =
			schedule.state === 0
				? 0
				: scheduler.retrievability(schedule as unknown as Record<string, unknown>, now, settings);

		const item: MobileCompanionDueCard = {
			propositionId,
			cueId: chosen.id,
			propositionName: graphNode?.name ?? prop.name ?? prop.snapshot?.name ?? propositionId,
			statement: graphNode?.statement ?? prop.statement ?? prop.snapshot?.statement ?? "",
			question: chosen.question,
			answer: chosen.answer,
			state: schedule.state,
			isDue: cardIsDue,
			retrievability,
			stability: Number(schedule.stability ?? 0),
			difficulty: Number(schedule.difficulty ?? 0),
			intervals: {
				"1": formatIntervalLabel(previews[1] ?? {}, now),
				"2": formatIntervalLabel(previews[2] ?? {}, now),
				"3": formatIntervalLabel(previews[3] ?? {}, now),
				"4": formatIntervalLabel(previews[4] ?? {}, now),
			},
		};

		if (cardIsDue) dueList.push(item);
		else newList.push(item);
	}

	dueList.sort((a, b) => {
		const aLearn = a.state === 1 || a.state === 3 ? 0 : 1;
		const bLearn = b.state === 1 || b.state === 3 ? 0 : 1;
		if (aLearn !== bLearn) return aLearn - bLearn;
		if (examPrep.activeScopeLabels.length > 0) {
			const aScope = prioritySet.has(a.propositionId) ? 0 : 1;
			const bScope = prioritySet.has(b.propositionId) ? 0 : 1;
			if (aScope !== bScope) return aScope - bScope;
		}
		return a.retrievability - b.retrievability;
	});

	const totalDue = dueList.length;
	const dueCards = [...dueList, ...newList].slice(0, 30);

	return {
		dueCards,
		totalDue,
		totalTracked,
		examPrep,
		planner,
		recentSessions,
	};
}

export function rateMobileCompanionCard(input: {
	propositionId: string;
	cueId?: string;
	rating: 1 | 2 | 3 | 4;
} & MobileCompanionOptions): {
	ok: boolean;
	ratedPropositionId: string;
	rating: 1 | 2 | 3 | 4;
	nextDue: number;
	state: MobileCompanionState;
} {
	if (!input || typeof input.propositionId !== "string" || !input.propositionId.trim()) {
		throw new MobileCompanionError("propositionId is required", 400);
	}
	if (![1, 2, 3, 4].includes(input.rating)) {
		throw new MobileCompanionError("rating must be 1, 2, 3, or 4", 400);
	}

	const flashcardsFile = input.flashcardsFile ?? defaultFlashcardsStorePath();
	const store = readFlashcardsStore(flashcardsFile);
	if (!store || !store.propositions || typeof store.propositions !== "object") {
		throw new MobileCompanionError("Flashcards store not found", 404);
	}

	const prop = store.propositions[input.propositionId];
	if (!prop || !prop.schedule) {
		throw new MobileCompanionError(`Proposition not found: ${input.propositionId}`, 404);
	}
	const activeCues = Array.isArray(prop.cues) ? prop.cues.filter((c) => c && !c.deleted) : [];
	if (activeCues.length === 0) {
		throw new MobileCompanionError("No active flashcards for proposition", 400);
	}
	const cue =
		(input.cueId ? activeCues.find((c) => c.id === input.cueId) : undefined) ??
		(prop.learningCueId ? activeCues.find((c) => c.id === prop.learningCueId) : undefined) ??
		activeCues[0]!;

	const scheduler = loadFlashcardsScheduler();
	const nowMs = input.now ?? Date.now();
	const settings = store.settings ?? {};
	const before = { ...prop.schedule };
	const introduced = prop.firstReviewedAt == null;
	const next = scheduler.rate(before as unknown as Record<string, unknown>, input.rating, nowMs, settings) as unknown as StoredSchedule;

	prop.schedule = next;
	prop.learningCueId = next.state === 1 || next.state === 3 ? cue.id : null;
	prop.firstReviewedAt ??= nowMs;
	cue.latestRating = input.rating;
	cue.lastReviewedAt = nowMs;
	prop.version = (prop.version ?? 0) + 1;

	const deckIds = Array.isArray(store.decks)
		? store.decks.filter((d) => Array.isArray(d.propositionIds) && d.propositionIds.includes(input.propositionId)).map((d) => d.id)
		: [];

	const reviewId = randomUUID();
	store.reviews ??= [];
	store.reviews.push({
		id: reviewId,
		requestId: `mobile:${reviewId}`,
		source: "mobile-companion",
		propositionId: input.propositionId,
		cueId: cue.id,
		rating: input.rating,
		at: nowMs,
		before,
		after: next,
		introduced,
		deckIds: introduced ? deckIds : [],
		settings: structuredClone(settings),
	});
	store.revision = (store.revision ?? 0) + 1;

	fs.mkdirSync(path.dirname(flashcardsFile), { recursive: true });
	writeFileAtomicSync(flashcardsFile, JSON.stringify(store), { allowInPlaceFallback: true });

	const state = getMobileCompanionState({
		flashcardsFile,
		examPrepFile: input.examPrepFile,
		plannerFile: input.plannerFile,
		chatsDir: input.chatsDir,
		graphStore: input.graphStore,
		now: nowMs,
	});

	return {
		ok: true,
		ratedPropositionId: input.propositionId,
		rating: input.rating,
		nextDue: Number(next.due ?? nowMs),
		state,
	};
}

export function updateMobileCompanionExamPrep(
	patch: ExamPrepPatch,
	opts: MobileCompanionOptions = {},
): { ok: boolean; examPrep: ExamPrepStatus } {
	writeExamPrepConfig(patch, opts.examPrepFile);
	const examPrep = readExamPrepStatus(
		opts.graphStore
			? {
				graphStore: opts.graphStore,
				examPrepFile: opts.examPrepFile,
				flashcardsFile: opts.flashcardsFile,
				now: opts.now,
			}
			: {
				examPrepFile: opts.examPrepFile,
				flashcardsFile: opts.flashcardsFile,
				now: opts.now,
			},
	);
	return { ok: true, examPrep };
}

function resolveChatJsonPath(chatsDir: string, chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		throw new MobileCompanionError(`Invalid chatId: ${chatId}`, 400);
	}
	return path.join(/* turbopackIgnore: true */ chatsDir, `${chatId}.json`);
}

function readChatRecord(chatsDir: string, chatId: string): ChatRecord {
	const file = resolveChatJsonPath(chatsDir, chatId);
	if (!fs.existsSync(file)) {
		throw new MobileCompanionError("Session not found", 404);
	}
	try {
		const raw = fs.readFileSync(/* turbopackIgnore: true */ file, "utf8");
		const parsed = JSON.parse(raw) as ChatRecord;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) {
			throw new MobileCompanionError("Session record is corrupt", 500);
		}
		return parsed;
	} catch (err) {
		if (err instanceof MobileCompanionError) throw err;
		throw new MobileCompanionError("Failed to read session", 500);
	}
}

function extractPromptFromToolBlock(block: unknown): string | null {
	if (!block || typeof block !== "object") return null;
	const b = block as { type?: unknown; name?: unknown; arguments?: unknown };
	if (b.type !== "toolCall" || !b.arguments || typeof b.arguments !== "object") return null;
	const args = b.arguments as Record<string, unknown>;
	if (typeof args.question === "string" && args.question.trim()) {
		return `[Question] ${args.question.trim()}`;
	}
	if (typeof args.problem === "string" && args.problem.trim()) {
		return `[Problem] ${args.problem.trim()}`;
	}
	if (typeof args.statement === "string" && args.statement.trim()) {
		return `[Problem] ${args.statement.trim()}`;
	}
	if (typeof args.prompt === "string" && args.prompt.trim()) {
		return `[Prompt] ${args.prompt.trim()}`;
	}
	return null;
}

function parsePendingQuestion(dangling: { toolCallId: string; tool: string; input: unknown }): {
	qd: QuestionData;
	pending: MobilePendingQuestion;
} | null {
	const raw = dangling.input;
	if (!raw || typeof raw !== "object") return null;
	const inp = raw as Record<string, unknown>;
	const kind = toolQuestionKind(dangling.tool);
	const question = typeof inp.question === "string" ? inp.question.trim() : "";
	let options: QuizOption[] = [];
	try {
		options = normalizeOptions(
			inp.options as string | Array<{ label: string; value?: string; description?: string }> | undefined,
		);
	} catch {
		options = [];
	}
	if (kind === "quiz" && options.length > 0) {
		options = shuffleOptions(options, seededRandom(dangling.toolCallId));
	}
	const multiSelect = inp.multiSelect === true;
	const mode = options.length > 0 ? (multiSelect ? "multi-select" : "single-select") : "text";
	let correctIndices: number[] | undefined;
	let explanation: string | undefined;
	let committedAnswer: string | undefined;
	if (kind === "quiz") {
		const resolved = resolveCorrect(inp.correctAnswer as string | string[] | undefined, options);
		correctIndices = resolved.indices;
		if (typeof inp.explanation === "string") explanation = inp.explanation;
	}
	if (kind === "explain" && typeof inp.committedAnswer === "string") {
		committedAnswer = inp.committedAnswer;
	}
	const qd: QuestionData = {
		id: dangling.toolCallId,
		kind,
		questionType: inp.questionType === "predict" || inp.questionType === "check" ? inp.questionType : undefined,
		question,
		context: typeof inp.details === "string" ? inp.details : typeof inp.context === "string" ? inp.context : undefined,
		mode,
		options,
		correctIndices,
		committedAnswer,
		explanation,
		createdAt: new Date().toISOString(),
	};
	return {
		qd,
		pending: {
			toolCallId: dangling.toolCallId,
			tool: dangling.tool,
			kind,
			question,
			multiSelect,
			options: options.map((o) => ({
				label: o.label,
				value: o.value,
				...(o.description ? { description: o.description } : {}),
			})),
		},
	};
}

function buildMobileQuestionAnswerRequest(
	qd: QuestionData,
	opts: { selectedValues?: string[]; replyText?: string; dontKnow?: boolean },
): AnswerRequest {
	const reply = opts.replyText?.trim() ?? "";
	let values = Array.isArray(opts.selectedValues) ? opts.selectedValues.filter((v) => typeof v === "string" && v) : [];

	if (opts.dontKnow) {
		return { dontKnow: true, ...(reply ? { thinking: reply } : {}) };
	}

	// If learner typed a 1-based option index ("1", "2") or exact option label in chat box, match it automatically.
	if (values.length === 0 && reply && qd.options.length > 0) {
		const idxMatch = /^([1-9][0-9]*)$/.exec(reply);
		if (idxMatch) {
			const idx = Number(idxMatch[1]) - 1;
			if (idx >= 0 && idx < qd.options.length) {
				values = [qd.options[idx]!.value];
			}
		} else {
			const normalized = reply.toLowerCase();
			const matched = qd.options.find(
				(o) => o.value.toLowerCase() === normalized || o.label.toLowerCase() === normalized,
			);
			if (matched) values = [matched.value];
		}
	}

	if (qd.kind === "explain") {
		return {
			text: reply || undefined,
			thinking: reply || undefined,
		};
	}
	if (qd.kind === "ask") {
		if (values.length > 0) {
			return { values, ...(reply && values[0] !== reply ? { other: reply } : {}) };
		}
		return qd.options.length > 0 ? { other: reply } : { text: reply };
	}
	// quiz / probe
	return {
		...(values.length > 0 ? { values } : { other: reply, thinking: reply }),
		confidence: 70,
	};
}

export async function getMobileCompanionSessionDetailAsync(
	chatId: string,
	opts: MobileCompanionOptions = {},
): Promise<MobileCompanionSessionDetail> {
	let busy = false;
	if (!opts.chatsDir) {
		try {
			const { isTurnRunning } = await import("./turn-liveness.ts");
			busy = isTurnRunning(chatId);
		} catch {
			busy = false;
		}
	}
	return buildSessionDetail(chatId, opts, busy);
}

export function getMobileCompanionSessionDetail(
	chatId: string,
	opts: MobileCompanionOptions = {},
): MobileCompanionSessionDetail {
	return buildSessionDetail(chatId, opts, false);
}

interface ToolAnswerShape {
	dismissed?: unknown;
	dontKnow?: unknown;
	text?: unknown;
	other?: unknown;
	thinking?: unknown;
	note?: unknown;
	readingThinking?: unknown;
	thinkingWhileReading?: unknown;
	answers?: unknown;
}

function parseFallbackToolAnswerJson(content: unknown): ToolAnswerShape | null {
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = (block as { type?: unknown; text?: unknown }).type === "text"
			? (block as { text?: unknown }).text
			: null;
		if (typeof text !== "string" || !text.trim().startsWith("{")) continue;
		try {
			const parsed = JSON.parse(text) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as ToolAnswerShape;
			}
		} catch {
			// ignore non-JSON tool output
		}
	}
	return null;
}

function extractQuestionToolResultUserText(msg: {
	toolName?: unknown;
	details?: unknown;
	content?: unknown;
	isError?: unknown;
}): string | null {
	if (msg.isError === true) return null;

	const cancellation = readPluginQuestionCancellation(msg.details);
	if (cancellation) return "[Skipped question]";

	const pluginAnswer = readPluginQuestionAnswer(msg.details);
	if (pluginAnswer) {
		const rawAnswer = typeof pluginAnswer.answer === "string"
			? pluginAnswer.answer.trim()
			: JSON.stringify(pluginAnswer.answer);
		const parts = [rawAnswer || "[Submitted answer]"];
		if (typeof pluginAnswer.thinking === "string" && pluginAnswer.thinking.trim() && pluginAnswer.thinking.trim() !== rawAnswer) {
			parts.push(`*(Thinking: ${pluginAnswer.thinking.trim()})*`);
		}
		if (typeof pluginAnswer.readingThinking === "string" && pluginAnswer.readingThinking.trim()) {
			parts.push(`*(Reading note: ${pluginAnswer.readingThinking.trim()})*`);
		}
		return parts.join("\n\n");
	}

	if (typeof msg.toolName !== "string" || !(QUESTION_TOOLS as readonly string[]).includes(msg.toolName)) {
		return null;
	}

	const raw = (msg.details && typeof msg.details === "object" && !Array.isArray(msg.details)
		? msg.details
		: parseFallbackToolAnswerJson(msg.content)) as ToolAnswerShape | null;
	if (!raw) return null;
	if (raw.dismissed === true) return "[Skipped question]";

	const parts: string[] = [];
	const selectedLabels = Array.isArray(raw.answers)
		? raw.answers
			.map((a) => (a && typeof a === "object" && typeof (a as { label?: unknown }).label === "string"
				? (a as { label: string }).label.trim()
				: ""))
			.filter(Boolean)
		: [];
	if (selectedLabels.length > 0) parts.push(selectedLabels.join("; "));

	const textVal = typeof raw.text === "string" ? raw.text.trim() : "";
	const otherVal = typeof raw.other === "string" ? raw.other.trim() : "";
	if (textVal) parts.push(textVal);
	if (otherVal && otherVal !== textVal) parts.push(otherVal);

	if (parts.length === 0 && raw.dontKnow === true) {
		parts.push("I don't know");
	}

	const thinkingVal = typeof raw.thinking === "string"
		? raw.thinking.trim()
		: (typeof raw.note === "string" ? raw.note.trim() : "");
	if (thinkingVal && thinkingVal !== textVal && thinkingVal !== otherVal) {
		parts.push(`*(Thinking: ${thinkingVal})*`);
	}

	const readingVal = typeof raw.readingThinking === "string"
		? raw.readingThinking.trim()
		: (typeof raw.thinkingWhileReading === "string" ? raw.thinkingWhileReading.trim() : "");
	if (readingVal) {
		parts.push(`*(Reading note: ${readingVal})*`);
	}

	return parts.length > 0 ? parts.join("\n\n") : null;
}

function extractCustomUserText(msg: { customType?: unknown; content?: unknown; details?: unknown }): string | null {
	if (msg.customType === "practice-thinking") {
		const details = msg.details as { text?: unknown; images?: unknown[] } | undefined;
		const detailText = typeof details?.text === "string" ? details.text.trim() : "";
		if (detailText) return detailText;
		if (typeof msg.content === "string") {
			const stripped = msg.content.replace(/^Your thinking:\s*\r?\n?/i, "").trim();
			if (stripped) return stripped;
		}
		if (Array.isArray(details?.images) && details.images.length > 0) return "[Sent work photo]";
		return null;
	}
	if (msg.customType === "plugin-problem-submission") {
		const sub = readPluginProblemSubmission(msg.details);
		if (!sub) return null;
		const parts: string[] = [];
		if (typeof sub.submission === "string" && sub.submission.trim()) {
			parts.push(sub.submission.trim());
		} else if (sub.submission != null) {
			parts.push(JSON.stringify(sub.submission));
		}
		if (sub.thinking.trim()) parts.push(sub.thinking.trim());
		if (parts.length === 0 && sub.images) return "[Submitted problem image]";
		return parts.length > 0 ? parts.join("\n\n") : "[Submitted problem solution]";
	}
	return null;
}

function buildSessionDetail(
	chatId: string,
	opts: MobileCompanionOptions,
	busy: boolean,
): MobileCompanionSessionDetail {
	const chatsDir = opts.chatsDir ?? PATHS.chats;
	const record = readChatRecord(chatsDir, chatId);
	const failedOutputs = failedOutputCallIds(record.messages);

	const items: MobileCompanionMessageItem[] = [];
	for (const msg of record.messages) {
		if (!msg) continue;
		if (msg.role === "user") {
			let text = userFacingTextOf(msg.content).join("\n").trim();
			if (!text && Array.isArray(msg.content) && msg.content.some((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "image")) {
				text = "[Attached image]";
			}
			if (text) {
				items.push({ id: msg.id, role: "user", text, timestamp: msg.timestamp });
			}
		} else if (msg.role === "toolResult") {
			const text = extractQuestionToolResultUserText(msg);
			if (text) {
				items.push({ id: msg.id, role: "user", text, timestamp: msg.timestamp });
			}
		} else if (msg.role === "custom") {
			const text = extractCustomUserText(msg);
			if (text) {
				items.push({ id: msg.id, role: "user", text, timestamp: msg.timestamp });
			}
		} else if (msg.role === "assistant") {
			const parts = [...userFacingTextOf(msg.content, failedOutputs)];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					const prompt = extractPromptFromToolBlock(block);
					if (prompt) parts.push(prompt);
				}
			}
			const text = parts.join("\n\n").trim();
			if (text) {
				items.push({ id: msg.id, role: "assistant", text, timestamp: msg.timestamp });
			}
		}
	}

	let pendingQuestionPrompt: string | null = null;
	let pendingQuestion: MobilePendingQuestion | null = null;
	const dangling = danglingQuestionOf(record.messages);
	const activeProb = activeProblemOf(record.messages);

	if (dangling) {
		pendingQuestion = parsePendingQuestion(dangling)?.pending ?? null;
	}

	const targetCallId = dangling?.toolCallId ?? activeProb?.toolCallId;
	if (targetCallId) {
		for (let i = record.messages.length - 1; i >= 0; i--) {
			const msg = record.messages[i];
			if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			const block = msg.content.find((c) => c && typeof c === "object" && (c as { id?: unknown }).id === targetCallId);
			const extracted = extractPromptFromToolBlock(block);
			if (extracted) {
				pendingQuestionPrompt = extracted;
				break;
			}
		}
	}

	return {
		id: record.id || chatId,
		title: record.title || "Untitled session",
		mode: record.kind === "practice" ? "practice" : "teach",
		notes: typeof record.notes === "string" ? record.notes : "",
		busy,
		pendingQuestionPrompt,
		pendingQuestion,
		messageCount: items.length,
		messages: items.slice(-60),
	};
}

function sanitizeMobileAttachmentPaths(rawPaths: unknown, attachmentsDir?: string): string[] {
	if (!Array.isArray(rawPaths) || rawPaths.length === 0) return [];
	const baseDir = path.resolve(/* turbopackIgnore: true */ attachmentsDir ?? PATHS.attachments);
	let realBaseDir = baseDir;
	try {
		realBaseDir = fs.realpathSync(/* turbopackIgnore: true */ baseDir);
	} catch {
		// attachmentsDir may not exist yet before any valid file was written
	}

	const seen = new Set<string>();
	const quoted: string[] = [];
	for (const entry of rawPaths) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const resolved = path.resolve(/* turbopackIgnore: true */ trimmed);
		const rel = path.relative(/* turbopackIgnore: true */ baseDir, resolved);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new MobileCompanionError("Invalid attachment path", 400);
		}
		if (!fs.existsSync(/* turbopackIgnore: true */ resolved) || !fs.statSync(/* turbopackIgnore: true */ resolved).isFile()) {
			throw new MobileCompanionError("Attachment file not found", 400);
		}
		try {
			const realFile = fs.realpathSync(/* turbopackIgnore: true */ resolved);
			const realRel = path.relative(/* turbopackIgnore: true */ realBaseDir, realFile);
			if (!realRel || realRel.startsWith("..") || path.isAbsolute(realRel)) {
				throw new MobileCompanionError("Invalid attachment path", 400);
			}
		} catch (err) {
			if (err instanceof MobileCompanionError) throw err;
		}
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		quoted.push(quoteFilePath(resolved));
	}
	return quoted;
}

export async function appendMobileCompanionSessionNoteOrReply(
	input: {
		chatId: string;
		note?: string;
		replyText?: string;
		attachmentPaths?: string[];
		selectedValues?: string[];
		dontKnow?: boolean;
	},
	opts: MobileCompanionOptions = {},
): Promise<{
	ok: boolean;
	triggeredAiTurn: boolean;
	session: MobileCompanionSessionDetail;
}> {
	const chatsDir = opts.chatsDir ?? PATHS.chats;
	const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
	if (!chatId) throw new MobileCompanionError("chatId is required", 400);

	const record = readChatRecord(chatsDir, chatId);
	let modifiedRecord = false;

	if (typeof input.note === "string") {
		if (input.note.length > 0) record.notes = input.note;
		else delete record.notes;
		modifiedRecord = true;
	}

	const replyRaw = typeof input.replyText === "string" ? input.replyText.trim() : "";
	const quotedAttachments = sanitizeMobileAttachmentPaths(input.attachmentPaths, opts.attachmentsDir);
	const reply = [replyRaw, ...quotedAttachments].filter(Boolean).join("\n");
	const hasSelection = Array.isArray(input.selectedValues) && input.selectedValues.length > 0;
	const hasAnswerAction = Boolean(reply || hasSelection || input.dontKnow);

	if (modifiedRecord) {
		writeFileAtomicSync(resolveChatJsonPath(chatsDir, chatId), JSON.stringify(record, null, "\t"), {
			allowInPlaceFallback: true,
		});
	}

	let triggeredAiTurn = false;
	if (hasAnswerAction) {
		if (!opts.chatsDir) {
			try {
				const [{ handleChatInput }, { isTurnRunning }] = await Promise.all([
					import("./chat-handler.ts"),
					import("./turn-liveness.ts"),
				]);
				if (!isTurnRunning(chatId)) {
					const activeProb = activeProblemOf(record.messages);
					const dangling = danglingQuestionOf(record.messages);
					let turnInput: Parameters<typeof handleChatInput>[1] | null = null;

					if (activeProb) {
						if (reply) {
							turnInput = { type: "thinking", problemCallId: activeProb.toolCallId, text: reply };
						}
					} else if (dangling) {
						const parsed = parsePendingQuestion(dangling);
						if (parsed) {
							const req = buildMobileQuestionAnswerRequest(parsed.qd, {
								selectedValues: input.selectedValues,
								replyText: reply,
								dontKnow: input.dontKnow,
							});
							const answer = buildAnswer(parsed.qd, req, dangling.tool);
							turnInput = { type: "answer", toolCallId: dangling.toolCallId, answer };
						}
					} else if (reply) {
						turnInput = { type: "text", text: reply };
					}

					if (turnInput) {
						const res = await handleChatInput(chatId, turnInput);
						if (res.ok) {
							triggeredAiTurn = true;
							void res.arrayBuffer().catch(() => {});
							// Give the streaming turn a brief beat so initial state & turn liveness settle.
							await new Promise((resolve) => setTimeout(resolve, 120));
						}
					}
				}
			} catch {
				// Fall back to persisting the learner's text directly on disk.
			}
		}

		if (!triggeredAiTurn && reply) {
			const fresh = readChatRecord(chatsDir, chatId);
			fresh.messages.push(newUserMessage(reply));
			fresh.updatedAt = new Date().toISOString();
			writeFileAtomicSync(resolveChatJsonPath(chatsDir, chatId), JSON.stringify(fresh, null, "\t"), {
				allowInPlaceFallback: true,
			});
			emit("chats-changed", {});
		}
	}

	return {
		ok: true,
		triggeredAiTurn,
		session: await getMobileCompanionSessionDetailAsync(chatId, opts),
	};
}

export async function startMobileCompanionSession(
	input: {
		mode?: "teach" | "practice";
		prompt?: string;
		attachmentPaths?: string[];
		drill?: boolean;
	},
	opts: MobileCompanionOptions = {},
): Promise<{
	ok: boolean;
	chatId: string;
	triggeredAiTurn: boolean;
	session: MobileCompanionSessionDetail;
}> {
	const chatsDir = opts.chatsDir ?? PATHS.chats;
	const mode: "teach" | "practice" = input.mode === "practice" ? "practice" : "teach";
	const examStatus = readExamPrepStatus(
		opts.graphStore
			? {
				graphStore: opts.graphStore,
				examPrepFile: opts.examPrepFile,
				flashcardsFile: opts.flashcardsFile,
				now: opts.now,
			}
			: {
				examPrepFile: opts.examPrepFile,
				flashcardsFile: opts.flashcardsFile,
				now: opts.now,
			},
	);

	const rawPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	const quotedAttachments = sanitizeMobileAttachmentPaths(input.attachmentPaths, opts.attachmentsDir);
	let prompt = rawPrompt;
	const picks: Array<{ id: string; name: string; statement: string }> = [];
	let chainLines: string[] = [];

	if (input.drill) {
		const graph = opts.graphStore
			? {
				propositions: opts.graphStore.readNodes(),
				nodes: opts.graphStore.readNodes(),
				chains: opts.graphStore.readChains(),
			}
			: graphView();
		const pool = graph.propositions.length > 0 ? graph.propositions : graph.nodes;
		const byId = new Map(pool.map((n) => [n.id, n]));
		const pickedNodes: Array<(typeof pool)[number]> = [];
		for (const id of examStatus.priorityPropositionIds.slice(0, 8)) {
			const node = byId.get(id);
			if (node) {
				pickedNodes.push(node);
				picks.push({ id: node.id, name: node.name, statement: node.statement });
			}
		}
		if (pickedNodes.length > 0) {
			const propMap = Object.fromEntries(byId);
			chainLines = chainsForSelection(pickedNodes, graph.chains).map((c) => formatChainLine(c, propMap));
		}
		if (!prompt) {
			const label = examStatus.config.examTitle || examStatus.activeScopeLabels.join(", ") || "Weak & Due Concepts";
			const topNames = picks.slice(0, 3).map((p) => p.name).join(", ");
			prompt = topNames
				? `Exam Drill (${label}): practice ${topNames}`
				: `Exam Drill (${label}): review weak roots and due topics`;
		}
	}

	if (!prompt && quotedAttachments.length > 0) {
		prompt = "Review the attached material:";
	}
	if (quotedAttachments.length > 0) {
		prompt = [prompt, ...quotedAttachments].filter(Boolean).join("\n");
	}

	if (!prompt) {
		throw new MobileCompanionError("Prompt or attachment is required to start a session", 400);
	}

	const title = titleFromPrompt(rawPrompt || (!input.drill && quotedAttachments.length > 0 ? "Review attached material" : prompt));

	if (opts.chatsDir) {
		fs.mkdirSync(chatsDir, { recursive: true });
		const chatId = `chat_${randomUUID().slice(0, 8)}`;
		const nowIso = new Date().toISOString();
		const messages = [
			...(picks.length > 0 ? [newGraphContextMessage(picks, chainLines)] : []),
			newUserMessage(prompt),
		];
		const record: ChatRecord = {
			id: chatId,
			title,
			kind: mode,
			createdAt: nowIso,
			updatedAt: nowIso,
			messages,
		};
		writeFileAtomicSync(resolveChatJsonPath(chatsDir, chatId), JSON.stringify(record, null, "\t"), {
			allowInPlaceFallback: true,
		});
		return {
			ok: true,
			chatId,
			triggeredAiTurn: false,
			session: getMobileCompanionSessionDetail(chatId, opts),
		};
	}

	const created = stores.chatStore.createChat(title, mode === "practice" ? "practice" : undefined);
	const strong = effectiveSettings().models.strong;
	if (strong) {
		stores.chatStore.saveSettings(created.id, {
			model: { provider: strong.provider, id: strong.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	if (picks.length > 0) {
		stores.chatStore.saveMessages(created.id, [newGraphContextMessage(picks, chainLines)]);
	}

	let triggeredAiTurn = false;
	try {
		const { handleChatInput } = await import("./chat-handler.ts");
		const res = await handleChatInput(created.id, { type: "text", text: prompt });
		if (res.ok) {
			triggeredAiTurn = true;
			void res.arrayBuffer().catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 120));
		}
	} catch {
		const existing = stores.chatStore.getChat(created.id)?.messages ?? [];
		stores.chatStore.saveMessages(created.id, [...existing, newUserMessage(prompt)]);
	}

	return {
		ok: true,
		chatId: created.id,
		triggeredAiTurn,
		session: await getMobileCompanionSessionDetailAsync(created.id, opts),
	};
}

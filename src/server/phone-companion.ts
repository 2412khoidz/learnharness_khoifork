import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { ChatRecord } from "../core/contracts.ts";
import type { ExamPrepConfig, ExamPrepStatus } from "../core/exam-prep.ts";
import { userFacingTextOf } from "../core/native-messages.ts";
import type { GraphStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { readExamPrepStatus, writeExamPrepConfig } from "./exam-prep.ts";
import { defaultFlashcardsStorePath, loadFlashcardsScheduler } from "./graph-fsrs.ts";
import { stores } from "./stores.ts";

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
	updatedAt: string;
	messageCount: number;
	lastAssistantSnippet: string;
}

export interface MobileCompanionState {
	dueCards: MobileCompanionDueCard[];
	totalDue: number;
	totalTracked: number;
	examPrep: ExamPrepStatus;
	recentSessions: MobileCompanionSessionItem[];
}

export interface MobileCompanionOptions {
	flashcardsFile?: string;
	examPrepFile?: string;
	chatsDir?: string;
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
	try {
		if (!fs.existsSync(file)) return null;
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredFlashcardsFile;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
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

function readRecentSessions(chatsDir = PATHS.chats, limit = 6): MobileCompanionSessionItem[] {
	try {
		if (!fs.existsSync(chatsDir)) return [];
		const files = fs.readdirSync(/* turbopackIgnore: true */ chatsDir).filter((f) => f.endsWith(".json"));
		const items: MobileCompanionSessionItem[] = [];
		for (const file of files) {
			try {
				const raw = fs.readFileSync(path.join(/* turbopackIgnore: true */ chatsDir, file), "utf8");
				const record = JSON.parse(raw) as ChatRecord;
				if (!record || typeof record !== "object" || !Array.isArray(record.messages)) continue;
				let snippet = "";
				for (let i = record.messages.length - 1; i >= 0; i--) {
					const msg = record.messages[i];
					if (!msg || msg.role !== "assistant") continue;
					const texts = userFacingTextOf(msg.content);
					if (texts.length > 0) {
						const joined = texts.join("\n").replace(/\s+/g, " ").trim();
						snippet = joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
						break;
					}
				}
				items.push({
					id: record.id || file.slice(0, -5),
					title: record.title || "Untitled session",
					mode: record.kind === "practice" ? "practice" : "teach",
					updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
					messageCount: record.messages.length,
					lastAssistantSnippet: snippet,
				});
			} catch {
				// Ignore unreadable/corrupt individual chat records
			}
		}
		items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return items.slice(0, limit);
	} catch {
		return [];
	}
}

export function getMobileCompanionState(opts: MobileCompanionOptions = {}): MobileCompanionState {
	const now = opts.now ?? Date.now();
	const flashcardsFile = opts.flashcardsFile ?? defaultFlashcardsStorePath();
	const graphStore = opts.graphStore ?? stores.graphStore;
	const examPrep = readExamPrepStatus({
		graphStore,
		examPrepFile: opts.examPrepFile,
		flashcardsFile,
		now,
	});
	const recentSessions = readRecentSessions(opts.chatsDir ?? PATHS.chats);

	const store = readFlashcardsStore(flashcardsFile);
	if (!store || !store.propositions || typeof store.propositions !== "object") {
		return {
			dueCards: [],
			totalDue: 0,
			totalTracked: 0,
			examPrep,
			recentSessions,
		};
	}

	const nodeLookup = new Map<string, { name: string; statement: string }>();
	if (graphStore) {
		for (const node of graphStore.readNodes()) {
			nodeLookup.set(node.id, { name: node.name, statement: node.statement });
		}
	}

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
		return a.retrievability - b.retrievability;
	});

	const totalDue = dueList.length;
	const dueCards = [...dueList, ...newList].slice(0, 30);

	return {
		dueCards,
		totalDue,
		totalTracked,
		examPrep,
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
	patch: Partial<ExamPrepConfig>,
	opts: MobileCompanionOptions = {},
): { ok: boolean; examPrep: ExamPrepStatus } {
	writeExamPrepConfig(patch, opts.examPrepFile);
	const examPrep = readExamPrepStatus({
		graphStore: opts.graphStore,
		examPrepFile: opts.examPrepFile,
		flashcardsFile: opts.flashcardsFile,
		now: opts.now,
	});
	return { ok: true, examPrep };
}

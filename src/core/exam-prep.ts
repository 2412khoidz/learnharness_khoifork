import type { GraphFsrsSummary } from "./fsrs-graph.ts";

export type StudyMode = "long-term" | "exam";
export type StudyPace = "thorough" | "efficient" | "crash-course";

export interface ExamScopeOption {
	id: string;
	label: string;
	nodeCount: number;
	trackedCount: number;
	dueCount: number;
	readinessPct: number;
}

export interface ExamProfile {
	id: string;
	title: string;
	date: string | null;
	pace: StudyPace;
	clusterIds: string[];
}

export interface ExamPrepConfig {
	mode: StudyMode;
	examTitle: string;
	examDate: string | null;
	pace: StudyPace;
	clusterIds: string[];
	exams: ExamProfile[];
	activeExamId: string | null;
	updatedAt: string;
}

export type ExamPrepConfigInput = Omit<ExamPrepConfig, "clusterIds" | "exams" | "activeExamId"> &
	Partial<Pick<ExamPrepConfig, "clusterIds" | "exams" | "activeExamId">>;

export type ExamPrepPatch = Partial<ExamPrepConfig> & {
	selectExamId?: string | null;
	upsertExam?: {
		id?: string;
		title?: string;
		date?: string | null;
		pace?: StudyPace;
		clusterIds?: string[];
	};
	deleteExamId?: string;
	clearExam?: boolean;
};

export interface ExamScopeContext {
	availableScopes?: ExamScopeOption[];
	activeScopeLabels?: string[];
	scopedNodeCount?: number;
	totalNodeCount?: number;
	priorityPropositionIds?: string[];
}

export interface ExamPrepStatus {
	config: ExamPrepConfig;
	daysRemaining: number | null;
	examReadinessPct: number;
	trackedCount: number;
	dueCount: number;
	weakFoundationsCount: number;
	untrackedFoundationsCount: number;
	duePropositionNames: string[];
	weakFoundationNames: string[];
	untrackedFoundationNames: string[];
	availableScopes: ExamScopeOption[];
	activeScopeLabels: string[];
	scopedNodeCount: number;
	totalNodeCount: number;
	priorityPropositionIds: string[];
	promptDirective: string | null;
}

export const DEFAULT_EXAM_PREP_CONFIG: ExamPrepConfig = {
	mode: "long-term",
	examTitle: "",
	examDate: null,
	pace: "thorough",
	clusterIds: [],
	exams: [],
	activeExamId: null,
	updatedAt: "",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function sanitizeClusterIds(raw: unknown, fallback: readonly string[] = []): string[] {
	if (!Array.isArray(raw)) return [...fallback];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
		if (out.length >= 64) break;
	}
	return out;
}

function sanitizeDate(raw: unknown, fallback: string | null): string | null {
	if (raw === null || raw === "") return null;
	if (typeof raw === "string" && DATE_RE.test(raw.trim())) return raw.trim();
	return fallback;
}

function sanitizePace(raw: unknown, fallback: StudyPace): StudyPace {
	return raw === "efficient" || raw === "crash-course" || raw === "thorough" ? raw : fallback;
}

function sanitizeExams(raw: unknown, fallback: readonly ExamProfile[] = []): ExamProfile[] {
	if (!Array.isArray(raw)) return fallback.map((e) => ({ ...e, clusterIds: [...e.clusterIds] }));
	const seen = new Set<string>();
	const out: ExamProfile[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		const id = typeof obj.id === "string" ? obj.id.trim().slice(0, 64) : "";
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 120) : "";
		out.push({
			id,
			title: title || "Untitled Exam",
			date: sanitizeDate(obj.date, null),
			pace: sanitizePace(obj.pace, "efficient"),
			clusterIds: sanitizeClusterIds(obj.clusterIds),
		});
		if (out.length >= 30) break;
	}
	return out;
}

export function sanitizeExamPrepConfig(raw: unknown, fallback: ExamPrepConfig = DEFAULT_EXAM_PREP_CONFIG): ExamPrepConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {
			...fallback,
			clusterIds: [...(fallback.clusterIds ?? [])],
			exams: (fallback.exams ?? []).map((e) => ({ ...e, clusterIds: [...e.clusterIds] })),
		};
	}
	const input = raw as Record<string, unknown>;
	const mode: StudyMode = input.mode === "exam" ? "exam" : input.mode === "long-term" ? "long-term" : fallback.mode;
	const pace = sanitizePace(input.pace, fallback.pace);
	const examTitle = typeof input.examTitle === "string"
		? input.examTitle.trim().slice(0, 120)
		: fallback.examTitle;
	const examDate = sanitizeDate(input.examDate, fallback.examDate);
	const clusterIds = sanitizeClusterIds(input.clusterIds, fallback.clusterIds);
	let exams = sanitizeExams(input.exams, fallback.exams);
	let activeExamId: string | null = fallback.activeExamId;
	if (input.activeExamId === null || input.activeExamId === "") {
		activeExamId = null;
	} else if (typeof input.activeExamId === "string" && exams.some((e) => e.id === input.activeExamId)) {
		activeExamId = input.activeExamId;
	} else if (activeExamId && !exams.some((e) => e.id === activeExamId)) {
		activeExamId = null;
	}
	// Migrate pre-profile single-exam config into a real profile so users can switch or delete it.
	if (exams.length === 0 && (examTitle !== "" || examDate !== null)) {
		const migratedId = "exam_legacy";
		exams = [
			{
				id: migratedId,
				title: examTitle || "Exam",
				date: examDate,
				pace,
				clusterIds: [...clusterIds],
			},
		];
		activeExamId = migratedId;
	}
	const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : fallback.updatedAt;
	return { mode, examTitle, examDate, pace, clusterIds, exams, activeExamId, updatedAt };
}

/** Apply an incremental config patch or multi-exam profile action cleanly. */
export function applyExamPrepPatch(
	current: ExamPrepConfig,
	patch: ExamPrepPatch,
	nowIso = new Date().toISOString(),
): ExamPrepConfig {
	const base = sanitizeExamPrepConfig(current, DEFAULT_EXAM_PREP_CONFIG);
	let exams = base.exams.map((e) => ({ ...e, clusterIds: [...e.clusterIds] }));
	let activeExamId = base.activeExamId;
	let mode: StudyMode = patch.mode === "exam" || patch.mode === "long-term" ? patch.mode : base.mode;
	let examTitle = typeof patch.examTitle === "string" ? patch.examTitle.trim().slice(0, 120) : base.examTitle;
	let examDate = patch.examDate !== undefined ? sanitizeDate(patch.examDate, base.examDate) : base.examDate;
	let pace = patch.pace !== undefined ? sanitizePace(patch.pace, base.pace) : base.pace;
	let clusterIds = patch.clusterIds !== undefined ? sanitizeClusterIds(patch.clusterIds) : [...base.clusterIds];

	if (Array.isArray(patch.exams)) {
		exams = sanitizeExams(patch.exams, exams);
		if (activeExamId && !exams.some((e) => e.id === activeExamId)) {
			activeExamId = null;
		}
	}

	const removeExamId =
		typeof patch.deleteExamId === "string" && patch.deleteExamId
			? patch.deleteExamId
			: patch.clearExam && activeExamId
				? activeExamId
				: null;
	if (removeExamId) {
		exams = exams.filter((e) => e.id !== removeExamId);
	}
	if ((removeExamId && activeExamId === removeExamId) || (patch.clearExam && !removeExamId)) {
		const nextProfile = exams[0] ?? null;
		if (nextProfile) {
			activeExamId = nextProfile.id;
			examTitle = nextProfile.title;
			examDate = nextProfile.date;
			pace = nextProfile.pace;
			clusterIds = [...nextProfile.clusterIds];
		} else {
			activeExamId = null;
			examTitle = "";
			examDate = null;
			clusterIds = [];
		}
	}

	if (patch.upsertExam && typeof patch.upsertExam === "object") {
		const rawId = typeof patch.upsertExam.id === "string" ? patch.upsertExam.id.trim().slice(0, 64) : "";
		const id = rawId || `exam_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
		const existingIdx = exams.findIndex((e) => e.id === id);
		const existing = existingIdx >= 0 ? exams[existingIdx] : undefined;
		const title = typeof patch.upsertExam.title === "string"
			? patch.upsertExam.title.trim().slice(0, 120) || "Untitled Exam"
			: existing?.title ?? (examTitle || "Untitled Exam");
		const date = patch.upsertExam.date !== undefined
			? sanitizeDate(patch.upsertExam.date, existing?.date ?? null)
			: (existing?.date ?? examDate);
		const profilePace = patch.upsertExam.pace !== undefined
			? sanitizePace(patch.upsertExam.pace, existing?.pace ?? pace)
			: (existing?.pace ?? pace);
		const profileClusters = patch.upsertExam.clusterIds !== undefined
			? sanitizeClusterIds(patch.upsertExam.clusterIds)
			: (existing ? [...existing.clusterIds] : [...clusterIds]);
		const profile: ExamProfile = {
			id,
			title,
			date,
			pace: profilePace,
			clusterIds: profileClusters,
		};
		if (existingIdx >= 0) exams[existingIdx] = profile;
		else exams = [profile, ...exams].slice(0, 30);

		activeExamId = profile.id;
		examTitle = profile.title;
		examDate = profile.date;
		pace = profile.pace;
		clusterIds = [...profile.clusterIds];
		if (!patch.mode) mode = "exam";
	} else if (patch.selectExamId !== undefined) {
		if (patch.selectExamId === null || patch.selectExamId === "") {
			activeExamId = null;
		} else {
			const selected = exams.find((e) => e.id === patch.selectExamId);
			if (selected) {
				activeExamId = selected.id;
				examTitle = selected.title;
				examDate = selected.date;
				pace = selected.pace;
				clusterIds = [...selected.clusterIds];
				if (!patch.mode) mode = "exam";
			}
		}
	}

	if (patch.mode !== undefined) mode = patch.mode;
	if (patch.examTitle !== undefined) examTitle = patch.examTitle.trim().slice(0, 120);
	if (patch.examDate !== undefined) examDate = sanitizeDate(patch.examDate, examDate);
	if (patch.pace !== undefined) pace = sanitizePace(patch.pace, pace);
	if (patch.clusterIds !== undefined) clusterIds = sanitizeClusterIds(patch.clusterIds);

	// Keep the currently selected ExamProfile synced when top-level exam fields are edited.
	if (activeExamId && !patch.selectExamId) {
		const idx = exams.findIndex((e) => e.id === activeExamId);
		if (idx >= 0) {
			exams[idx] = {
				id: activeExamId,
				title: examTitle || exams[idx]!.title,
				date: examDate,
				pace,
				clusterIds: [...clusterIds],
			};
		}
	}

	return sanitizeExamPrepConfig(
		{
			mode,
			examTitle,
			examDate,
			pace,
			clusterIds,
			exams,
			activeExamId,
			updatedAt: nowIso,
		},
		base,
	);
}

export function computeDaysRemaining(examDate: string | null, now = Date.now()): number | null {
	if (!examDate || !DATE_RE.test(examDate)) return null;
	const [yStr, mStr, dStr] = examDate.split("-");
	const y = Number(yStr);
	const m = Number(mStr);
	const d = Number(dStr);
	if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
	const targetUtc = Date.UTC(y, m - 1, d);
	const current = new Date(now);
	const todayUtc = Date.UTC(current.getFullYear(), current.getMonth(), current.getDate());
	return Math.round((targetUtc - todayUtc) / DAY_MS);
}

const PACE_DIRECTIVE: Record<StudyPace, string> = {
	thorough:
		"Pace (Thorough): Prioritize deep derivation, conceptual proof understanding, and full foundational grounding before advancing.",
	efficient:
		"Pace (Efficient): Balance intuition with core proofs, reinforce due or decaying foundations first, and skip redundant detours.",
	"crash-course":
		"Pace (Crash Course): Maximize exam score per minute — focus on high-yield theorems, weak/due foundations, worked problem templates, and rapid retrieval checks over lengthy background derivations.",
};

export function computeExamPrepStatus(
	config: ExamPrepConfigInput,
	fsrs: GraphFsrsSummary,
	now = Date.now(),
	nodes: ReadonlyArray<{ id: string; name: string }> = [],
	scopeContext?: ExamScopeContext,
): ExamPrepStatus {
	const normalized = sanitizeExamPrepConfig(config);
	const daysRemaining = computeDaysRemaining(normalized.examDate, now);
	const dueCount = (fsrs.counts.overdue ?? 0) + (fsrs.counts.decaying ?? 0);
	const weakFoundationsCount = fsrs.counts.weakFoundations ?? 0;
	const untrackedFoundationsCount = fsrs.counts.untrackedFoundations ?? 0;

	const nodeNames = new Map<string, string>();
	for (const n of nodes) {
		nodeNames.set(n.id, n.name);
	}
	const nameOf = (propId: string) => nodeNames.get(propId) || propId;

	const fsrsList = Object.values(fsrs.nodes ?? {});
	const weakFoundationsSorted = fsrsList
		.filter((n) => n.isFoundation && (n.memoryBand === "overdue" || n.memoryBand === "decaying"))
		.sort((a, b) => (b.dependentCount - a.dependentCount) || ((a.retrievability ?? 0) - (b.retrievability ?? 0)));

	const dueSorted = fsrsList
		.filter((n) => n.memoryBand === "overdue" || n.memoryBand === "decaying")
		.sort((a, b) => (a.retrievability ?? 0) - (b.retrievability ?? 0));

	const untrackedFoundationsSorted = fsrsList
		.filter((n) => n.isFoundation && n.state === "untracked")
		.sort((a, b) => b.dependentCount - a.dependentCount);

	const weakFoundationNames = weakFoundationsSorted.slice(0, 6).map((n) => nameOf(n.id));
	const duePropositionNames = dueSorted.slice(0, 8).map((n) => nameOf(n.id));
	const untrackedFoundationNames = untrackedFoundationsSorted.slice(0, 6).map((n) => nameOf(n.id));

	const priorityIds: string[] = [];
	const seenIds = new Set<string>();
	const pushId = (id: string) => {
		if (!id || seenIds.has(id) || priorityIds.length >= 12) return;
		seenIds.add(id);
		priorityIds.push(id);
	};
	for (const n of weakFoundationsSorted) pushId(n.id);
	for (const n of dueSorted) pushId(n.id);
	for (const n of fsrsList) {
		if (n.weakPrerequisites.length > 0) pushId(n.id);
	}
	for (const n of untrackedFoundationsSorted) pushId(n.id);
	for (const n of nodes) pushId(n.id);

	const activeScopeLabels = scopeContext?.activeScopeLabels ?? [];
	const availableScopes = scopeContext?.availableScopes ?? [];
	const scopedNodeCount = scopeContext?.scopedNodeCount ?? nodes.length;
	const totalNodeCount = scopeContext?.totalNodeCount ?? nodes.length;
	const priorityPropositionIds = scopeContext?.priorityPropositionIds ?? priorityIds;

	let promptDirective: string | null = null;
	if (!(normalized.mode === "long-term" && normalized.pace === "thorough") || activeScopeLabels.length > 0) {
		const header = normalized.mode === "exam"
			? [
				"Active Mode: Dedicated Exam Prep",
				normalized.examTitle ? `(${normalized.examTitle})` : "",
				daysRemaining !== null
					? `— ${daysRemaining > 0 ? `${daysRemaining} day(s) remaining` : daysRemaining === 0 ? "Exam day today" : `${Math.abs(daysRemaining)} day(s) past target date`}`
					: "",
			].filter(Boolean).join(" ")
			: "Active Mode: Long-Term Mastery";

		const metrics = `Current FSRS-6 Metrics: Exam Readiness ${fsrs.examReadinessPct}% · Tracked ${fsrs.counts.tracked} · Due/Decaying ${dueCount} · Weak foundations ${weakFoundationsCount} · Untracked foundations ${untrackedFoundationsCount}.`;
		const briefingLines = [
			header,
			activeScopeLabels.length > 0 ? `Focused Subject Scope: ${activeScopeLabels.join(", ")} (${scopedNodeCount}/${totalNodeCount} propositions).` : "",
			metrics,
			weakFoundationNames.length > 0 ? `Priority Weak Foundations (reinforce first): ${weakFoundationNames.join(", ")}.` : "",
			duePropositionNames.length > 0 ? `Due/Decaying Propositions: ${duePropositionNames.join(", ")}.` : "",
			untrackedFoundationNames.length > 0 ? `Untracked Foundations (no FSRS cards yet): ${untrackedFoundationNames.join(", ")}.` : "",
			PACE_DIRECTIVE[normalized.pace],
		].filter(Boolean);
		promptDirective = `[ChronoHarness Study Mode Directive]\n${briefingLines.join("\n")}`;
	}

	return {
		config: normalized,
		daysRemaining,
		examReadinessPct: fsrs.examReadinessPct,
		trackedCount: fsrs.counts.tracked,
		dueCount,
		weakFoundationsCount,
		untrackedFoundationsCount,
		duePropositionNames,
		weakFoundationNames,
		untrackedFoundationNames,
		availableScopes,
		activeScopeLabels,
		scopedNodeCount,
		totalNodeCount,
		priorityPropositionIds,
		promptDirective,
	};
}

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

export interface ExamPrepMistakeHints {
	totalCount: number;
	recurringPattern: string | null;
	recentRules: string[];
}

export interface ExamScopeContext {
	availableScopes?: ExamScopeOption[];
	activeScopeLabels?: string[];
	scopedNodeCount?: number;
	totalNodeCount?: number;
	priorityPropositionIds?: string[];
	mistakeHints?: ExamPrepMistakeHints;
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
	mistakeHints?: ExamPrepMistakeHints;
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

export type StudyDirectiveRole = "prober" | "teacher" | "practice";

const PACE_ROLE_DIRECTIVE: Record<StudyDirectiveRole, Record<StudyPace, string>> = {
	prober: {
		thorough:
			"Pace (Thorough): Map all relevant strands (floor and ceiling) thoroughly before calling probe_done.",
		efficient:
			"Pace (Efficient): Overrides exhaustive multi-round probing in your base doctrine. Keep placement short: ask roughly half as many questions as usual, avoid redundant cross-checks once adjacent strands are clear, prioritize weak or due FSRS foundations, and call probe_done as soon as the map is clear enough to plan.",
		"crash-course":
			"Pace (Crash Course): Overrides exhaustive multi-round probing in your base doctrine. The learner is short on time: ask the fewest questions needed (~2-4 total) to locate their starting point and critical weak or due FSRS gaps, and call probe_done immediately once the picture is clear.",
	},
	teacher: {
		thorough:
			"Pace (Thorough): Prioritize deep derivation, conceptual proof understanding, and full foundational grounding before advancing.",
		efficient:
			"Pace (Efficient): Overrides \"thorough, deep, real understanding — not coverage\" and \"never rush forward\" in your base method. Balance intuition with core proofs, reinforcing weak or due FSRS foundations first and skipping redundant detours. Give each plan node only the questions it needs (usually 1-2): when one unhinted answer shows the step, accept it and advance without extra confirmation quizzes (exception: if a hint was needed, verify that step once more on a fresh case). Repair only real gaps briefly — never re-teach what the learner already holds, though a wrong answer on a step or prerequisite IS a real gap that must be repaired and retried before moving on.",
		"crash-course":
			"Pace (Crash Course): Optimize for high-yield mastery per minute. Overrides \"thorough, deep, real understanding — not coverage\", \"No size ceiling\", and \"never rush forward\" in your base method. Keep the lesson map small (only high-yield nodes toward the goal, prioritizing weak/due FSRS foundations). For each concept teach: (1) core idea, (2) solution procedure, and (3) cue for when to use it. Ask ONE check question per plan node instead of quizzing every sub-step (exception: a hinted answer requires one fresh-case check). Keep repairs tight: show the missing step, get one clean retry, then move on — never build on an unverified wrong answer and never skip a prerequisite the learner demonstrably lacks. When omitting deeper proofs, state in one concise line what depth was skipped so the learner can ask for it.",
	},
	practice: {
		thorough:
			"Pace (Thorough): Keep full Socratic nudging without premature reveals, prioritizing deep structural mastery before advancing.",
		efficient:
			"Pace (Efficient): Keep feedback crisp (a few lines: what worked in one phrase, first break, smallest nudge; never restate confirmed parts). Prioritize weak and due FSRS foundations when selecting problem targets. Overrides \"A failed attempt is never a reason to reveal the correction or conclude the problem\" if nudges stall: keep nudging while the learner moves forward, but if the same break survives two nudges or they are far off, state the core idea and missing step concisely and conclude with outcome movedOn (retest: true for key gaps) rather than dragging.",
		"crash-course":
			"Pace (Crash Course): Optimize practice throughput per minute. Overrides \"A failed attempt is never a reason to reveal the correction or conclude the problem\" and multi-round stalling in your base doctrine. Keep feedback ultra-short (what worked, first break, smallest cue). Target weak/due FSRS foundations and exam-style transfer problems over easy warmups. Stop nudging once the same break survives two nudges or a new wrong turn follows each fix: state the core idea, applicability cue, and missing worked step in one short paragraph, conclude with outcome movedOn (retest: true on critical gaps), then move on.",
	},
};

function examSelectionLine(pace: StudyPace): string {
	return pace === "thorough"
		? "Exam Triage: Use the exam target/countdown and FSRS weak/due foundations to prioritize what to cover first and trim off-target tangents, while preserving full derivation depth unless the learner asks to move faster."
		: "Exam Triage: Let the exam target and countdown guide what to cut vs. drill — weight high-yield exam topics and weak/due FSRS foundations ahead of low-yield detours.";
}

interface DirectiveSummaryInput {
	mode: StudyMode;
	pace: StudyPace;
	examTitle: string;
	daysRemaining: number | null;
	activeScopeLabels: readonly string[];
	scopedNodeCount: number;
	totalNodeCount: number;
	examReadinessPct: number;
	trackedCount: number;
	dueCount: number;
	weakFoundationsCount: number;
	untrackedFoundationsCount: number;
	weakFoundationNames: readonly string[];
	duePropositionNames: readonly string[];
	untrackedFoundationNames: readonly string[];
	mistakeHints?: ExamPrepMistakeHints;
}

function mistakeDirectiveLine(hints: ExamPrepMistakeHints | undefined, role: StudyDirectiveRole): string {
	if (!hints || hints.totalCount <= 0) return "";
	const headParts = [`Recorded Mistakes: ${hints.totalCount} total`];
	if (hints.recurringPattern) headParts.push(`top pattern: ${hints.recurringPattern}`);
	const parts = [`${headParts.join(" · ")}.`];
	if (hints.recentRules.length > 0) {
		parts.push(`Guard these "Next time" rules: ${hints.recentRules.map((rule) => `"${rule}"`).join("; ")}.`);
	}
	if (role === "teacher") {
		parts.push("Use the `mistakes` tool for full error details when repairing misses.");
	}
	return parts.join(" ");
}

function renderStudyModeDirective(input: DirectiveSummaryInput, role: StudyDirectiveRole): string | null {
	if (input.mode === "long-term" && input.pace === "thorough" && input.activeScopeLabels.length === 0) {
		return null;
	}
	const header = input.mode === "exam"
		? [
			"Active Mode: Dedicated Exam Prep",
			input.examTitle ? `(${input.examTitle})` : "",
			input.daysRemaining !== null
				? `— ${input.daysRemaining > 0 ? `${input.daysRemaining} day(s) remaining` : input.daysRemaining === 0 ? "Exam day today" : `${Math.abs(input.daysRemaining)} day(s) past target date`}`
				: "",
		].filter(Boolean).join(" ")
		: "Active Mode: Long-Term Mastery";

	const metrics = `Current FSRS-6 Metrics: Exam Readiness ${input.examReadinessPct}% · Tracked ${input.trackedCount} · Due/Decaying ${input.dueCount} · Weak foundations ${input.weakFoundationsCount} · Untracked foundations ${input.untrackedFoundationsCount}.`;
	const briefingLines = [
		header,
		input.activeScopeLabels.length > 0 ? `Focused Subject Scope: ${input.activeScopeLabels.join(", ")} (${input.scopedNodeCount}/${input.totalNodeCount} propositions).` : "",
		metrics,
		input.weakFoundationNames.length > 0 ? `Priority Weak Foundations (reinforce first): ${input.weakFoundationNames.join(", ")}.` : "",
		input.duePropositionNames.length > 0 ? `Due/Decaying Propositions: ${input.duePropositionNames.join(", ")}.` : "",
		input.untrackedFoundationNames.length > 0 ? `Untracked Foundations (no FSRS cards yet): ${input.untrackedFoundationNames.join(", ")}.` : "",
		mistakeDirectiveLine(input.mistakeHints, role),
		input.mode === "exam" ? examSelectionLine(input.pace) : "",
		PACE_ROLE_DIRECTIVE[role][input.pace],
	].filter(Boolean);
	return `[ChronoHarness Study Mode Directive]\n${briefingLines.join("\n")}`;
}

/** Render a role-tailored Study Mode + FSRS directive, or null when in pure default Long-Term/Thorough mode. */
export function formatExamPrepDirectiveForRole(
	status: ExamPrepStatus,
	role: StudyDirectiveRole = "teacher",
): string | null {
	return renderStudyModeDirective(
		{
			mode: status.config.mode,
			pace: status.config.pace,
			examTitle: status.config.examTitle,
			daysRemaining: status.daysRemaining,
			activeScopeLabels: status.activeScopeLabels,
			scopedNodeCount: status.scopedNodeCount,
			totalNodeCount: status.totalNodeCount,
			examReadinessPct: status.examReadinessPct,
			trackedCount: status.trackedCount,
			dueCount: status.dueCount,
			weakFoundationsCount: status.weakFoundationsCount,
			untrackedFoundationsCount: status.untrackedFoundationsCount,
			weakFoundationNames: status.weakFoundationNames,
			duePropositionNames: status.duePropositionNames,
			untrackedFoundationNames: status.untrackedFoundationNames,
			mistakeHints: status.mistakeHints,
		},
		role,
	);
}

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

	const promptDirective = renderStudyModeDirective(
		{
			mode: normalized.mode,
			pace: normalized.pace,
			examTitle: normalized.examTitle,
			daysRemaining,
			activeScopeLabels,
			scopedNodeCount,
			totalNodeCount,
			examReadinessPct: fsrs.examReadinessPct,
			trackedCount: fsrs.counts.tracked,
			dueCount,
			weakFoundationsCount,
			untrackedFoundationsCount,
			weakFoundationNames,
			duePropositionNames,
			untrackedFoundationNames,
			mistakeHints: scopeContext?.mistakeHints,
		},
		"teacher",
	);

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
		...(scopeContext?.mistakeHints ? { mistakeHints: scopeContext.mistakeHints } : {}),
		promptDirective,
	};
}

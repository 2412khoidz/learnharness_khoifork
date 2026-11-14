import type { GraphFsrsSummary } from "./fsrs-graph.ts";

export type StudyMode = "long-term" | "exam";
export type StudyPace = "thorough" | "efficient" | "crash-course";

export interface ExamPrepConfig {
	mode: StudyMode;
	examTitle: string;
	examDate: string | null;
	pace: StudyPace;
	updatedAt: string;
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
	promptDirective: string | null;
}

export const DEFAULT_EXAM_PREP_CONFIG: ExamPrepConfig = {
	mode: "long-term",
	examTitle: "",
	examDate: null,
	pace: "thorough",
	updatedAt: "",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function sanitizeExamPrepConfig(raw: unknown, fallback: ExamPrepConfig = DEFAULT_EXAM_PREP_CONFIG): ExamPrepConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...fallback };
	const input = raw as Record<string, unknown>;
	const mode: StudyMode = input.mode === "exam" ? "exam" : input.mode === "long-term" ? "long-term" : fallback.mode;
	const pace: StudyPace = input.pace === "efficient" || input.pace === "crash-course" || input.pace === "thorough"
		? input.pace
		: fallback.pace;
	const examTitle = typeof input.examTitle === "string"
		? input.examTitle.trim().slice(0, 120)
		: fallback.examTitle;
	let examDate: string | null = fallback.examDate;
	if (input.examDate === null || input.examDate === "") {
		examDate = null;
	} else if (typeof input.examDate === "string" && DATE_RE.test(input.examDate.trim())) {
		examDate = input.examDate.trim();
	}
	const updatedAt = typeof input.updatedAt === "string" ? input.updatedAt : fallback.updatedAt;
	return { mode, examTitle, examDate, pace, updatedAt };
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
	config: ExamPrepConfig,
	fsrs: GraphFsrsSummary,
	now = Date.now(),
	nodes: ReadonlyArray<{ id: string; name: string }> = [],
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

	const weakFoundationNames = fsrsList
		.filter((n) => n.isFoundation && (n.memoryBand === "overdue" || n.memoryBand === "decaying"))
		.sort((a, b) => (b.dependentCount - a.dependentCount) || ((a.retrievability ?? 0) - (b.retrievability ?? 0)))
		.slice(0, 6)
		.map((n) => nameOf(n.id));

	const duePropositionNames = fsrsList
		.filter((n) => n.memoryBand === "overdue" || n.memoryBand === "decaying")
		.sort((a, b) => (a.retrievability ?? 0) - (b.retrievability ?? 0))
		.slice(0, 8)
		.map((n) => nameOf(n.id));

	const untrackedFoundationNames = fsrsList
		.filter((n) => n.isFoundation && n.state === "untracked")
		.sort((a, b) => b.dependentCount - a.dependentCount)
		.slice(0, 6)
		.map((n) => nameOf(n.id));

	let promptDirective: string | null = null;
	if (!(normalized.mode === "long-term" && normalized.pace === "thorough")) {
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
			metrics,
			weakFoundationNames.length > 0 ? `Priority Weak Foundations (reinforce first): ${weakFoundationNames.join(", ")}.` : "",
			duePropositionNames.length > 0 ? `Due/Decaying Propositions: ${duePropositionNames.join(", ")}.` : "",
			untrackedFoundationNames.length > 0 ? `Untracked Foundations (no FSRS cards yet): ${untrackedFoundationNames.join(", ")}.` : "",
			PACE_DIRECTIVE[normalized.pace],
		].filter(Boolean);
		promptDirective = `[KronoHarness Study Mode Directive]\n${briefingLines.join("\n")}`;
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
		promptDirective,
	};
}

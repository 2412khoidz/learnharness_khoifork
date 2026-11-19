/**
 * Scientific Cognitive & Learning Capacity Diagnostics ("Lực học cá nhân")
 * 100% pure & browser-safe.
 *
 * Synthesizes established educational-psychology & computational memory telemetry
 * from the learner's real workspace:
 *  1. FSRS-6 DSR Memory Consolidation (Stability S, Difficulty D, Retrievability R, True Retention)
 *  2. Metacognitive Calibration (Brier Score & Over/Underconfidence Bias from quiz probabilities)
 *  3. Transfer & Problem-Solving Velocity (Practice solve rate, hint-rung independence, minutes/problem)
 *  4. Knowledge Graph Structural Integrity (Prerequisite chains & threshold foundation mastery)
 *  5. Error Taxonomy (Reason's Cognitive Slip vs Conceptual Schema Gap ratio from Mistake Ledger)
 *  6. Chronobiological Alignment & SRL Endurance (Circadian drift, sleep continuity, EWMA realism)
 */

import type { ExamPrepMistakeHints } from "./exam-prep.ts";
import type { GraphFsrsSummary } from "./fsrs-graph.ts";
import { summarizeRecallObservations, type RecallObservation, type RecallSubjectInsights } from "./recall-insights.ts";
import { computeRecallCapacity, recallCompositeAdjustment, type RecallCapacityProfile } from "./recall-capacity.ts";
import type { RecallGroupView } from "./recall-groups.ts";
import type { MistakeRecord } from "./mistakes.ts";
import type { RecallWorkloadFocus } from "./planner.ts";
import {
	addDaysToDate,
	journalBedtimeForNight,
	journalWakeForDate,
	normalizeSubjectKey,
	type PlannerConfig,
	type PlannerPersonalSignals,
} from "./planner.ts";

export type LearningCapacityAxisId =
	| "memory_consolidation"
	| "metacognitive_calibration"
	| "problem_velocity"
	| "foundation_mastery"
	| "error_taxonomy"
	| "circadian_endurance";

export interface QuizConfidenceSample {
	answerId?: string;
	subject?: string;
	sessionTitle: string;
	confidencePct: number | null; // 0-100 stated probability (null when dontKnow or legacy)
	correct: boolean;
	dontKnow: boolean;
	origin: string;
}

export interface PracticeOutcomeSample {
	subject?: string;
	sessionTitle: string;
	outcome: "solved" | "solvedWithHints" | "movedOn" | "surrendered";
	rung: string | null;
	missClass: string | null;
	durationMin: number | null;
}

export interface LearningCapacityDimension {
	id: LearningCapacityAxisId;
	title: string;
	scientificBasis: string;
	score: number | null; // 0-100, null when zero samples observed
	statusLabel: string;
	primaryMetric: {
		label: string;
		value: string;
		unit: string;
	};
	subMetrics: Array<{ label: string; value: string }>;
	sampleCount: number;
	insight: string;
}

export interface SubjectLearningCapacityDetail {
	subject: string;
	readinessPct: number;
	readinessBaseline: boolean;
	reviewedConcepts: number;
	graphConcepts: number;
	retentionPct: number | null;
	avgStabilityDays: number | null;
	avgDifficulty: number | null;
	solveRatePct: number | null;
	avgMinPerProblem: number | null;
	quizBiasPct: number | null;
	brierScore: number | null;
	paceFactor: number;
	paceBaseline: boolean;
	sampleCount: number;
	recallEvidence: SubjectRecallEvidence;
	recallInsights: RecallSubjectInsights;
	recallCapacity?: RecallCapacityProfile;
	approvedRecallGroups?: { last30: RecallGroupView[]; allTime: RecallGroupView[] };
}

/** Stored AI scan results are tentative assessments, not FSRS reviews or grades. */
export interface SubjectRecallEvidence {
	responses: number;
	assessed: number;
	correct: number;
	partial: number;
	wrong: number;
	dontKnow: number;
	uncertain: number;
}

export interface LearningCapacityReport {
	generatedAt: string;
	compositeScore: number | null; // 0-100 weighted index
	legacyCompositeScore?: number | null;
	recallContribution?: { delta: number; eligibleSubjects: number; activeSubjects: number };
	tierLabel: string;
	confidenceLevel: "calibrated" | "emerging" | "insufficient";
	recommendedPaceFactor: number; // 0.75..1.65 (workload multiplier)
	recommendedRealismFactor: number; // 0.65..1.25 (daily capacity ratio)
	recommendedDailyHours: number | null;
	dataCoverage: {
		recallAnswers?: number;
		recallAssigned?: number;
		recallUnassigned?: number;
		recallUnassignedExamples?: Array<{ chatId: string; sourceMessageId?: string; toolCallId?: string }>;
		fsrsReviews: number;
		trackedPropositions: number;
		hasCustomFsrsWeights: boolean;
		fsrsDecayW20?: number;
		fsrsInitEasyW3?: number;
		graphNodes: number;
		graphChains: number;
		quizSamples: number;
		quizConfidenceSamples: number;
		practiceProblems: number;
		recallExplainCount?: number;
		mistakeRecords: number;
		pastChatSessions: number;
		loggedPlannerDays: number;
	};
	metacognition: {
		sampleCount: number;
		brierScore: number | null;
		calibrationBiasPct: number | null;
		biasDirection: "overconfident" | "underconfident" | "calibrated" | "unknown";
		dontKnowRatePct: number | null;
	};
	errorProfile: {
		totalAnalyzed: number;
		schemaGapPct: number | null;
		slipRatePct: number | null;
		topErrorType: string | null;
		recentRules: string[];
	};
	dimensions: LearningCapacityDimension[];
	subjectBreakdown: SubjectLearningCapacityDetail[];
	personalHighlights: string[];
}

export interface LearningCapacityTelemetryInput {
	config: PlannerConfig;
	signals: PlannerPersonalSignals;
	graphFsrs?: GraphFsrsSummary | null;
	fsrsWeights?: readonly number[];
	fsrsReviewRatings?: readonly number[];
	fsrsRecallAnswerIds?: readonly string[];
	graphNodeCount?: number;
	graphChainCount?: number;
	quizSamples?: readonly QuizConfidenceSample[];
	practiceSamples?: readonly PracticeOutcomeSample[];
	recallExplainCount?: number;
	recallBySubject?: Readonly<Record<string, SubjectRecallEvidence>>;
	recallObservationsBySubject?: Readonly<Record<string, readonly RecallObservation[]>>;
	pastChatSessionCount?: number;
	mistakes?: readonly MistakeRecord[];
	now?: number;
}

export interface CapacityAiDiagnosis {
	summary: string;
	strengths: string[];
	bottlenecks: string[];
	neuroProtocols: string[];
	suggestedPaceNote: string;
	modelLabel: string;
	suggestedScore?: { score: number; reason: string; evidenceIds: string[] };
}

export interface CapacityCalibrationPreview {
	date: string;
	revision: string;
	plannedStudyHours: number | null;
	undoId: string | null;
	realism: { current: number | null; recommended: number };
	proposals: Array<{
		id: string;
		blockId: string;
		date: string;
		subject: string;
		title: string;
		startTime: string;
		endTime: string;
		previous?: RecallWorkloadFocus;
		focus: RecallWorkloadFocus;
		graded: number;
		days: number;
		provisional: number;
		helpUnknown: number;
		full: number;
	}>;
}

type ExperimentLoss = { brier: number; logLoss: number };
export type CapacityExperiment =
	| { status: "insufficient"; observations: number }
	| { status: "improved" | "baseline"; train: number; test: number; measured: ExperimentLoss; reference: ExperimentLoss };

export interface CapacityExperiments {
	fsrs: CapacityExperiment;
	recall: CapacityExperiment & { next?: { subject: string; full: number } };
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}

function roundTo(n: number, decimals = 1): number {
	const p = Math.pow(10, decimals);
	return Math.round(n * p) / p;
}

function rungToNumber(rung: string | null): number {
	if (!rung) return 0;
	const m = rung.match(/R(\d+)/i);
	if (!m) return 0;
	return clamp(Number(m[1]), 0, 4);
}

const SLIP_ERROR_TYPES = new Set<string>(["calculation-slip", "misread"]);

function statusForScore(score: number | null, samples: number): string {
	if (score === null || samples === 0) return "No data yet";
	if (score >= 82) return "Strong";
	if (score >= 66) return "Solid";
	if (score >= 48) return "Developing";
	return "Needs Focus";
}

function parseClockMinutesSimple(hhmm?: string): number | null {
	if (!hhmm) return null;
	const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h < 0 || h > 23 || min < 0 || min > 59) return null;
	return h * 60 + min;
}

function sleepDurationHours(bed?: string, wake?: string): number | null {
	const b = parseClockMinutesSimple(bed);
	const w = parseClockMinutesSimple(wake);
	if (b === null || w === null) return null;
	const normB = b < 15 * 60 ? b + 1440 : b;
	const normW = w < 15 * 60 ? w + 1440 : w;
	let diff = normW - normB;
	if (diff <= 0) diff += 1440;
	if (diff < 60 || diff > 16 * 60) return null;
	return diff / 60;
}

/**
 * Pure deterministic evaluator combining FSRS-6 memory parameters, quiz confidence
 * calibration (Brier), practice problem velocity, Graph foundation mastery,
 * Mistake error taxonomy, and chronobiological adherence logs.
 */
export function computeLearningCapacityReport(input: LearningCapacityTelemetryInput): LearningCapacityReport {
	const now = input.now ?? Date.now();
	const { config, signals } = input;
	const lp = signals.learningProfile;
	const graphFsrs = input.graphFsrs ?? null;
	const quizSamples = input.quizSamples ?? [];
	const practiceSamples = input.practiceSamples ?? [];
	const mistakes = input.mistakes ?? [];
	const fsrsRatings = input.fsrsReviewRatings ?? [];

	// ── 1. FSRS-6 DSR Memory Consolidation ─────────────────────────────────────
	const nodeValues = graphFsrs ? Object.values(graphFsrs.nodes).filter((n) => n.state !== "untracked" && n.reps > 0) : [];
	const subjValues = Object.values(lp?.bySubject ?? {});

	let avgStabilityDays: number | null = null;
	if (nodeValues.length > 0) {
		avgStabilityDays = roundTo(nodeValues.reduce((a, n) => a + n.stability, 0) / nodeValues.length, 1);
	} else {
		const subjWithStab = subjValues.filter((s) => s.avgStabilityDays !== null && s.fsrsTrackedNodes > 0);
		if (subjWithStab.length > 0) {
			const wSum = subjWithStab.reduce((a, s) => a + (s.avgStabilityDays ?? 0) * s.fsrsTrackedNodes, 0);
			const wTot = subjWithStab.reduce((a, s) => a + s.fsrsTrackedNodes, 0);
			if (wTot > 0) avgStabilityDays = roundTo(wSum / wTot, 1);
		}
	}

	let avgDifficulty: number | null = null;
	if (nodeValues.length > 0) {
		avgDifficulty = roundTo(nodeValues.reduce((a, n) => a + n.difficulty, 0) / nodeValues.length, 2);
	} else {
		const subjWithDiff = subjValues.filter((s) => s.avgDifficulty !== null && s.fsrsTrackedNodes > 0);
		if (subjWithDiff.length > 0) {
			const wSum = subjWithDiff.reduce((a, s) => a + (s.avgDifficulty ?? 5) * s.fsrsTrackedNodes, 0);
			const wTot = subjWithDiff.reduce((a, s) => a + s.fsrsTrackedNodes, 0);
			if (wTot > 0) avgDifficulty = roundTo(wSum / wTot, 2);
		}
	}

	const fsrsReviewCount = Math.max(lp?.totalFsrsReviews ?? 0, fsrsRatings.length, graphFsrs?.reviewCount ?? 0);
	const trueRetentionPct =
		fsrsRatings.length > 0
			? Math.round((fsrsRatings.filter((r) => r >= 2).length / fsrsRatings.length) * 100)
			: lp?.overallRetentionPct ?? null;
	const passGoodEasyPct =
		fsrsRatings.length > 0
			? Math.round((fsrsRatings.filter((r) => r >= 3).length / fsrsRatings.length) * 100)
			: lp?.overallRetentionPct ?? null;
	const lapseRatePct =
		fsrsRatings.length > 0
			? Math.round((fsrsRatings.filter((r) => r === 1).length / fsrsRatings.length) * 100)
			: lp?.overallRetentionPct !== null && lp?.overallRetentionPct !== undefined
				? Math.max(0, 100 - lp.overallRetentionPct)
				: null;

	const hasCustomWeights = Boolean(graphFsrs?.hasCustomWeights || (input.fsrsWeights && input.fsrsWeights.length >= 21));
	const w20 = input.fsrsWeights && input.fsrsWeights.length >= 21 ? roundTo(input.fsrsWeights[20]!, 3) : undefined;
	const w3 = input.fsrsWeights && input.fsrsWeights.length >= 4 ? roundTo(input.fsrsWeights[3]!, 2) : undefined;

	// Reviews and reviewed concepts overlap; adding them double-counts the
	// same evidence. Fall back to concepts only if review records are absent.
	const memorySampleCount = fsrsReviewCount || nodeValues.length;
	let memoryScore: number | null = null;
	if (memorySampleCount > 0) {
		const stabScore = avgStabilityDays !== null ? clamp(Math.log1p(avgStabilityDays) / Math.log1p(35), 0, 1) * 42 : 20;
		const retScore = trueRetentionPct !== null ? clamp((trueRetentionPct - 45) / 50, 0, 1) * 46 : 22;
		const diffBonus = avgDifficulty !== null ? clamp((7.5 - avgDifficulty) / 5, 0, 1) * 12 : 6;
		const lapsePenalty = lapseRatePct !== null ? Math.max(0, lapseRatePct - 12) * 0.45 : 0;
		memoryScore = clamp(Math.round(stabScore + retScore + diffBonus - lapsePenalty), 10, 100);
	}

	const memoryDim: LearningCapacityDimension = {
		id: "memory_consolidation",
		title: "Long-Term Retention & Memory Stability",
		scientificBasis: "FSRS-6 DSR Memory Model (Stability S, Difficulty D, Decay w₂₀)",
		score: memoryScore,
		statusLabel: statusForScore(memoryScore, memorySampleCount),
		primaryMetric: avgStabilityDays !== null
			? { label: "Mean Stability S", value: `${avgStabilityDays}`, unit: "days (90% recall)" }
			: { label: "True Retention", value: passGoodEasyPct !== null ? `${passGoodEasyPct}%` : "—", unit: "FSRS pass" },
		subMetrics: [
			{ label: "True Retention", value: trueRetentionPct !== null ? `${trueRetentionPct}%` : "—" },
			{ label: "Good/Easy Pass", value: passGoodEasyPct !== null ? `${passGoodEasyPct}%` : "—" },
			{ label: "Lapse Rate (Again)", value: lapseRatePct !== null ? `${lapseRatePct}%` : "—" },
			{ label: "Mean Difficulty D", value: avgDifficulty !== null ? `${avgDifficulty}/10` : "—" },
			{ label: "FSRS Weights", value: hasCustomWeights ? `Personalized (21w${w20 !== undefined ? `, decay=${w20}` : ""})` : "Default FSRS-6" },
		],
		sampleCount: memorySampleCount,
		insight:
			memorySampleCount === 0
				? "Chưa có lượt ôn FSRS nào — mở Flashcards ôn thử vài khái niệm để đo chu kỳ quên cá nhân."
				: `Chu kỳ nhớ trung bình ${avgStabilityDays ?? "—"} ngày trước khi xác suất nhớ tụt xuống 90%; tỷ lệ nhớ đạt ${passGoodEasyPct ?? "—"}%${hasCustomWeights ? " (đã khớp bộ 21 trọng số FSRS-6 cá nhân)" : ""}.`,
	};

	// ── 2. Metacognitive Calibration (Brier Score & Confidence Bias) ───────────
	const confSamples = quizSamples.filter((q) => !q.dontKnow && q.confidencePct !== null);
	const dontKnowCount = quizSamples.filter((q) => q.dontKnow).length;
	const dontKnowRatePct = quizSamples.length > 0 ? Math.round((dontKnowCount / quizSamples.length) * 100) : null;

	let brierScore: number | null = null;
	let calibrationBiasPct: number | null = null;
	let biasDirection: "overconfident" | "underconfident" | "calibrated" | "unknown" = "unknown";
	let metaScore: number | null = null;

	if (confSamples.length > 0) {
		const sqErrSum = confSamples.reduce((acc, q) => {
			const p = clamp((q.confidencePct ?? 50) / 100, 0, 1);
			const y = q.correct ? 1 : 0;
			return acc + (p - y) * (p - y);
		}, 0);
		brierScore = roundTo(sqErrSum / confSamples.length, 3);

		const biasSum = confSamples.reduce((acc, q) => acc + ((q.confidencePct ?? 50) - (q.correct ? 100 : 0)), 0);
		calibrationBiasPct = Math.round(biasSum / confSamples.length);
		biasDirection =
			calibrationBiasPct > 8
				? "overconfident"
				: calibrationBiasPct < -8
					? "underconfident"
					: "calibrated";
		metaScore = clamp(Math.round((1 - Math.min(1, brierScore * 2.4)) * 100), 10, 100);
	}

	const quizAccuracyPct =
		quizSamples.length > 0
			? Math.round((quizSamples.filter((q) => q.correct).length / quizSamples.length) * 100)
			: null;

	const metaDim: LearningCapacityDimension = {
		id: "metacognitive_calibration",
		title: "Metacognitive Calibration",
		scientificBasis: "Brier Probability Scoring & Nelson-Narens Metamemory Monitoring",
		score: metaScore,
		statusLabel: statusForScore(metaScore, confSamples.length),
		primaryMetric: {
			label: "Brier Calibration Error",
			value: brierScore !== null ? `${brierScore}` : "—",
			unit: brierScore !== null ? "(0 = perfect)" : "no quiz confidence",
		},
		subMetrics: [
			{
				label: "Confidence Bias",
				value:
					calibrationBiasPct !== null
						? `${calibrationBiasPct > 0 ? "+" : ""}${calibrationBiasPct}% (${biasDirection})`
						: "—",
			},
			{ label: "Quiz Accuracy", value: quizAccuracyPct !== null ? `${quizAccuracyPct}%` : "—" },
			{ label: "\"I don't know\" Rate", value: dontKnowRatePct !== null ? `${dontKnowRatePct}%` : "—" },
		],
		sampleCount: confSamples.length,
		insight:
			confSamples.length === 0
				? "Chưa đủ mẫu thanh tự tin khi làm Quiz/Probe trong Chat Session để đo ảo giác thông thạo (Illusion of Competence)."
				: biasDirection === "overconfident"
					? `Có dấu hiệu tự tin cao hơn thực tế (+${calibrationBiasPct}%): dễ bị 'ảo giác đã hiểu' — nên tự giải lại không nhìn đáp án trước khi chuyển bài.`
					: biasDirection === "underconfident"
						? `Tự tin thấp hơn thực lực thực tế (${calibrationBiasPct}%): khả năng làm bài vững hơn cảm nhận chủ quan.`
						: `Độ tự nhận thức rất chuẩn (lệch ${calibrationBiasPct}%, Brier ${brierScore}): biết rõ phần nào mình thực sự nắm chắc vs chưa chắc.`,
	};

	// ── 3. Problem-Solving Velocity & Germane Independence ─────────────────────
	const totalProbSamples = practiceSamples.length;
	const solvedDirect = practiceSamples.filter((p) => p.outcome === "solved").length;
	const solvedHints = practiceSamples.filter((p) => p.outcome === "solvedWithHints").length;
	const rawSolveRatePct =
		totalProbSamples > 0
			? Math.round((solvedDirect / totalProbSamples) * 100)
			: lp?.overallSolveRatePct ?? null;
	const assistedSolveRatePct =
		totalProbSamples > 0
			? Math.round(((solvedDirect + solvedHints) / totalProbSamples) * 100)
			: null;
	const durSamples = practiceSamples.map((p) => p.durationMin).filter((d): d is number => d !== null && d > 0);
	const avgMinProb =
		durSamples.length > 0
			? Math.round(durSamples.reduce((a, b) => a + b, 0) / durSamples.length)
			: lp?.avgMinutesPerProblem ?? null;
	const avgHintRung =
		totalProbSamples > 0
			? roundTo(practiceSamples.reduce((a, p) => a + rungToNumber(p.rung), 0) / totalProbSamples, 2)
			: null;

	let velocityScore: number | null = null;
	const velocitySamples = Math.max(totalProbSamples, lp?.totalPracticeSessions ?? 0);
	if (velocitySamples > 0 && rawSolveRatePct !== null) {
		const indepPart = clamp(rawSolveRatePct / 100, 0, 1) * 58;
		const speedPart = avgMinProb !== null ? clamp((45 - avgMinProb) / 35, 0.15, 1) * 24 : 14;
		const rungPenalty = avgHintRung !== null ? avgHintRung * 5.5 : 0;
		const assistBonus = assistedSolveRatePct !== null ? (assistedSolveRatePct / 100) * 18 : 9;
		velocityScore = clamp(Math.round(indepPart + speedPart + assistBonus - rungPenalty), 10, 100);
	}

	const velocityDim: LearningCapacityDimension = {
		id: "problem_velocity",
		title: "Problem-Solving Velocity & Transfer",
		scientificBasis: "Sweller Cognitive Load Theory & ACT-R Autonomous Transfer",
		score: velocityScore,
		statusLabel: statusForScore(velocityScore, velocitySamples),
		primaryMetric: avgMinProb !== null
			? { label: "Solve Speed", value: `${avgMinProb}`, unit: "min / problem" }
			: { label: "Independent Solve", value: rawSolveRatePct !== null ? `${rawSolveRatePct}%` : "—", unit: "without hints" },
		subMetrics: [
			{ label: "Autonomous Solve", value: rawSolveRatePct !== null ? `${rawSolveRatePct}%` : "—" },
			{ label: "Solved w/ Hints", value: assistedSolveRatePct !== null ? `${assistedSolveRatePct}%` : "—" },
			{ label: "Mean Hint Depth", value: avgHintRung !== null ? `R${avgHintRung}` : "—" },
			{ label: "Topic Pace (Teach)", value: lp?.avgMinutesPerTopic !== null && lp?.avgMinutesPerTopic !== undefined ? `${lp.avgMinutesPerTopic}m/session` : "—" },
		],
		sampleCount: velocitySamples,
		insight:
			velocitySamples === 0
				? "Chưa có bài Practice nào được conclude — luyện vài bài trong chế độ Practice để đo tốc độ và mức phụ thuộc gợi ý."
				: `Tỷ lệ tự giải không cần gợi ý ${rawSolveRatePct ?? "—"}%, tốc độ trung bình ${avgMinProb ?? "—"} phút/bài (mức hint R${avgHintRung ?? 0}).`,
	};

	// ── 4. Knowledge Graph Structural Integrity ────────────────────────────────
	const totalGraphNodes = input.graphNodeCount ?? signals.subjectSignals.reduce((a, s) => a + s.nodeCount, 0);
	const totalWeakFoundations =
		graphFsrs?.counts.weakFoundations ?? signals.subjectSignals.reduce((a, s) => a + s.weakCount, 0);
	const totalPrereqRisk = graphFsrs?.counts.prereqRisk ?? 0;
	const totalUntrackedFound =
		graphFsrs?.counts.untrackedFoundations ?? signals.subjectSignals.reduce((a, s) => a + s.untrackedCount, 0);
	const graphReadiness = graphFsrs?.examReadinessPct ?? signals.examPrep.examReadinessPct;

	let graphScore: number | null = null;
	if (totalGraphNodes > 0) {
		const riskPenalty = Math.min(30, totalWeakFoundations * 3.5 + totalPrereqRisk * 3);
		graphScore = clamp(Math.round(graphReadiness - riskPenalty * 0.45), 8, 100);
	}

	const foundationDim: LearningCapacityDimension = {
		id: "foundation_mastery",
		title: "Conceptual Graph & Foundations",
		scientificBasis: "Schema Theory & Threshold Concept Prerequisite Density",
		score: graphScore,
		statusLabel: statusForScore(graphScore, totalGraphNodes),
		primaryMetric: {
			label: "Weighted Readiness",
			value: totalGraphNodes > 0 ? `${graphReadiness}%` : "—",
			unit: `${totalGraphNodes} nodes`,
		},
		subMetrics: [
			{ label: "Strong Nodes", value: `${graphFsrs?.counts.strong ?? 0}` },
			{ label: "Weak Foundations", value: `${totalWeakFoundations}` },
			{ label: "Prereq Decay Risks", value: `${totalPrereqRisk}` },
			{ label: "Untracked Roots", value: `${totalUntrackedFound}` },
		],
		sampleCount: totalGraphNodes,
		insight:
			totalGraphNodes === 0
				? "Knowledge Graph chưa có mệnh đề nào — trích xuất từ session học để hệ thống đo nền tảng."
				: totalWeakFoundations + totalPrereqRisk > 0
					? `Phát hiện ${totalWeakFoundations} khái niệm nền đang yếu và ${totalPrereqRisk} nhánh kiến thức nâng cao bị ảnh hưởng bởi tiền đề suy giảm.`
					: `Nền tảng Knowledge Graph cân bằng (${graphReadiness}% ready across ${totalGraphNodes} propositions).`,
	};

	// ── 5. Error Pattern Taxonomy (Slip vs Deep Schema Gap) ────────────────────
	const typeCounts = new Map<string, number>();
	let slipCount = 0;
	let schemaCount = 0;
	for (const m of mistakes) {
		const et = m.analysis?.errorType ?? (m.missClass === "careless" ? "calculation-slip" : undefined);
		if (!et) continue;
		typeCounts.set(et, (typeCounts.get(et) ?? 0) + 1);
		if (SLIP_ERROR_TYPES.has(et)) slipCount++;
		else schemaCount++;
	}
	for (const p of practiceSamples) {
		if (p.missClass === "careless") {
			slipCount++;
		}
	}
	const hintsFallback: ExamPrepMistakeHints | undefined = signals.mistakeHints;
	const analyzedErrCount = Math.max(slipCount + schemaCount, hintsFallback?.totalCount ?? 0);
	const schemaGapPct = slipCount + schemaCount > 0 ? Math.round((schemaCount / (slipCount + schemaCount)) * 100) : null;
	const slipRatePct = slipCount + schemaCount > 0 ? 100 - (schemaGapPct ?? 0) : null;
	const topErrEntry = [...typeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
	const topErrorType = topErrEntry?.[0] ?? hintsFallback?.recurringPattern ?? null;
	const recentRules = mistakes
		.map((m) => m.analysis?.rule)
		.filter((r): r is string => Boolean(r && r.trim()))
		.slice(0, 3);
	const effectiveRules = recentRules.length > 0 ? recentRules : (hintsFallback?.recentRules.slice(0, 3) ?? []);

	let errorScore: number | null = null;
	if (analyzedErrCount > 0) {
		// Higher score when errors are rare relative to solved tasks + fewer deep schema gaps
		const solvedBaseline = Math.max(1, solvedDirect + quizSamples.filter((q) => q.correct).length + fsrsReviewCount * 0.25);
		const errorBurden = clamp(analyzedErrCount / (solvedBaseline + analyzedErrCount), 0, 1);
		const slipShareBonus = slipRatePct !== null ? (slipRatePct / 100) * 14 : 5;
		errorScore = clamp(Math.round((1 - errorBurden * 0.85) * 86 + slipShareBonus), 15, 98);
	}

	const errorDim: LearningCapacityDimension = {
		id: "error_taxonomy",
		title: "Error Signature & Attention Load",
		scientificBasis: "Reason's Cognitive Slip vs Conceptual Schema Mistake Taxonomy",
		score: errorScore,
		statusLabel: statusForScore(errorScore, analyzedErrCount),
		primaryMetric: {
			label: schemaGapPct !== null ? "Schema Gap vs Slip" : "Analyzed Mistakes",
			value: schemaGapPct !== null ? `${schemaGapPct}% / ${slipRatePct}%` : `${analyzedErrCount}`,
			unit: schemaGapPct !== null ? "gap / slip" : "total",
		},
		subMetrics: [
			{ label: "Total Recorded", value: `${analyzedErrCount}` },
			{ label: "Schema Gaps", value: `${schemaCount}` },
			{ label: "Working-Mem Slips", value: `${slipCount}` },
			{ label: "Dominant Pattern", value: topErrorType ?? "—" },
		],
		sampleCount: analyzedErrCount,
		insight:
			analyzedErrCount === 0
				? "Chưa ghi nhận lỗi sai được phân tích trong sổ lỗi (Mistakes)."
				: slipRatePct !== null && slipRatePct >= 45
					? `${slipRatePct}% lỗi thuộc dạng nhầm dấu/đọc sót (Working-Memory Slip) — giảm độ dài mỗi phiên hoặc nghỉ vi mô để giữ tỉnh táo.`
					: `Phần lớn lỗi (${schemaGapPct ?? 100}%) là lỗ hổng mô hình kiến thức (${topErrorType ?? "knowledge-gap"}) — cần ôn lại định nghĩa và chứng minh gốc.`,
	};

	// ── 6. Chronobiological Alignment & SRL Endurance ──────────────────────────
	const allLogs = Object.values(config.logs);
	const complianceLogs = allLogs.filter((l) => l.compliance && l.compliance.scorable !== false && l.compliance.plannedStudyMin > 0);
	const avgAdherencePct =
		complianceLogs.length > 0
			? Math.round(complianceLogs.reduce((a, l) => a + (l.compliance?.adherencePct ?? 0), 0) / complianceLogs.length)
			: null;
	const sleepDurs = allLogs
		.map((l) => sleepDurationHours(journalBedtimeForNight(config.logs, addDaysToDate(l.date, -1))?.time, journalWakeForDate(config.logs, l.date)?.time))
		.filter((h): h is number => h !== null);
	const avgSleepHours = sleepDurs.length > 0 ? roundTo(sleepDurs.reduce((a, b) => a + b, 0) / sleepDurs.length, 1) : null;
	const earlyWakeCount = allLogs.filter((l) => l.wokeEarlyUnintended).length;
	const earlyWakingPct = allLogs.length > 0 ? Math.round((earlyWakeCount / allLogs.length) * 100) : null;

	const currentPlanHabit = config.plans[signals.date]?.habitStrength;
	const circadianDriftMin = currentPlanHabit?.circadianDriftMin ?? 0;
	const realismFactor = config.realismFactor ?? lp?.realismFactor ?? 1.0;

	const chronoSamples = allLogs.length + complianceLogs.length;
	let chronoScore: number | null = null;
	if (chronoSamples > 0 || config.realismFactor !== undefined) {
		const adhPart = avgAdherencePct !== null ? avgAdherencePct * 0.45 : 32;
		const energyPart = signals.habitTrend.avgEnergy !== null ? (signals.habitTrend.avgEnergy / 5) * 22 : 13;
		const sleepPart = avgSleepHours !== null ? clamp(1 - Math.abs(avgSleepHours - 7.5) / 3.5, 0.2, 1) * 23 : 15;
		const driftPen = Math.min(18, circadianDriftMin / 10);
		const earlyPen = earlyWakingPct !== null ? earlyWakingPct * 0.12 : 0;
		chronoScore = clamp(Math.round(adhPart + energyPart + sleepPart + 10 - driftPen - earlyPen), 15, 100);
	}

	const chronoDim: LearningCapacityDimension = {
		id: "circadian_endurance",
		title: "Circadian Stability & SRL Endurance",
		scientificBasis: "Borbély Two-Process Sleep Regulation & Self-Regulated Adherence EWMA",
		score: chronoScore,
		statusLabel: statusForScore(chronoScore, Math.max(1, chronoSamples)),
		primaryMetric: lp?.sustainableDailyHours !== null && lp?.sustainableDailyHours !== undefined
			? { label: "Sustainable Output", value: `${lp.sustainableDailyHours}h`, unit: "/ day" }
			: { label: "Realism Capacity", value: `${Math.round(realismFactor * 100)}%`, unit: "EWMA multiplier" },
		subMetrics: [
			{ label: "Plan Adherence", value: avgAdherencePct !== null ? `${avgAdherencePct}%` : "—" },
			{ label: "Mean Energy", value: signals.habitTrend.avgEnergy !== null ? `${signals.habitTrend.avgEnergy}/5` : "—" },
			{ label: "Mean Sleep", value: avgSleepHours !== null ? `${avgSleepHours}h` : "—" },
			{ label: "Circadian Drift", value: `±${circadianDriftMin}m` },
			{ label: "Early Waking Rate", value: earlyWakingPct !== null ? `${earlyWakingPct}%` : "—" },
		],
		sampleCount: Math.max(allLogs.length, complianceLogs.length),
		insight:
			allLogs.length === 0
				? "Chưa có log ngủ/học hàng ngày — check-in vài ngày để hệ thống học giờ tỉnh táo và sức bền thực tế."
				: `Sức bền thực tế EWMA ở mức ${Math.round(realismFactor * 100)}%${avgSleepHours ? `, ngủ TB ${avgSleepHours}h/đêm` : ""}${earlyWakingPct && earlyWakingPct > 25 ? " (lưu ý tần suất tỉnh sớm ngoài ý muốn khá cao)" : ""}.`,
	};

	const dimensions: LearningCapacityDimension[] = [
		memoryDim,
		metaDim,
		velocityDim,
		foundationDim,
		errorDim,
		chronoDim,
	];

	// ── Composite Learning Capacity Quotient & Pace Recommendation ─────────────
	const weights: Record<LearningCapacityAxisId, number> = {
		memory_consolidation: 0.22,
		metacognitive_calibration: 0.16,
		problem_velocity: 0.22,
		foundation_mastery: 0.16,
		error_taxonomy: 0.1,
		circadian_endurance: 0.14,
	};
	let weightedScoreSum = 0;
	let weightTot = 0;
	for (const dim of dimensions) {
		if (dim.score === null) continue;
		const sampleTrust = clamp(dim.sampleCount / 4, 0.4, 1);
		const w = weights[dim.id] * sampleTrust;
		weightedScoreSum += dim.score * w;
		weightTot += w;
	}
	const compositeScore = weightTot > 0 ? Math.round(weightedScoreSum / weightTot) : null;

	const confidenceLevel: LearningCapacityReport["confidenceLevel"] =
		(fsrsReviewCount >= 12 && (totalProbSamples + confSamples.length >= 4 || allLogs.length >= 3)) ||
		totalProbSamples + confSamples.length >= 16
			? "calibrated"
			: memorySampleCount + totalGraphNodes + totalProbSamples + confSamples.length + allLogs.length >= 3
				? "emerging"
				: "insufficient";

	const tierFor = (score: number | null) =>
		score === null || confidenceLevel === "insufficient"
			? "Telemetry Collecting"
			: score >= 82
				? "High Mastery Velocity"
				: score >= 68
					? "Steady Balanced"
					: score >= 52
						? "High-Effort Builder"
						: "High Friction / Needs Scaffolding";

	// Workload Pace Factor (higher = needs slightly more study time per milestone hour to consolidate properly)
	let recommendedPaceFactor = 1.0;
	if (compositeScore !== null) {
		const scoreOffset = (72 - compositeScore) * 0.008; // ±0.22
		const overconfAdd = calibrationBiasPct !== null && calibrationBiasPct > 12 ? 0.06 : 0;
		const slipAdd = slipRatePct !== null && slipRatePct > 50 ? 0.04 : 0;
		recommendedPaceFactor = roundTo(clamp(1.0 + scoreOffset + overconfAdd + slipAdd, 0.78, 1.55), 2);
	}

	const recommendedRealismFactor = roundTo(
		clamp(
			avgAdherencePct !== null
				? realismFactor * 0.65 + clamp(avgAdherencePct / 100, 0.65, 1.2) * 0.35
				: realismFactor,
			0.65,
			1.25,
		),
		2,
	);

	// ── Per-Subject Calibration Breakdown ──────────────────────────────────────
	const subjectBreakdown: SubjectLearningCapacityDetail[] = [];
	// Exclude only Recall items already scored in Recall-FSRS or in calibrated quizzes
	// (mistakes.json only contains misses, so excluding it would cause survivorship bias).
	const recallOverlap = new Set(input.fsrsRecallAnswerIds ?? []);
	for (const quiz of quizSamples) {
		if (quiz.answerId && !quiz.dontKnow && quiz.confidencePct !== null) {
			recallOverlap.add(quiz.answerId);
		}
	}
	const seenSubjKeys = new Set<string>();

	const quizBiasForSubject = (subjName: string): { bias: number | null; brier: number | null; accPct: number | null; n: number } => {
		const nk = normalizeSubjectKey(subjName);
		const matched = quizSamples.filter((q) => {
			if (q.subject && normalizeSubjectKey(q.subject) === nk) return true;
			const qs = normalizeSubjectKey(q.subject || q.sessionTitle);
			return Boolean(qs && (qs === nk || qs.includes(nk) || nk.includes(qs)));
		});
		const accPct = matched.length > 0
			? Math.round((matched.filter((q) => q.correct).length / matched.length) * 100)
			: null;
		const withConf = matched.filter((q) => !q.dontKnow && q.confidencePct !== null);
		if (withConf.length === 0) return { bias: null, brier: null, accPct, n: matched.length };
		const brier = roundTo(
			withConf.reduce((a, q) => {
				const p = clamp((q.confidencePct ?? 50) / 100, 0, 1);
				return a + Math.pow(p - (q.correct ? 1 : 0), 2);
			}, 0) / withConf.length,
			3,
		);
		const bias = Math.round(
			withConf.reduce((a, q) => a + ((q.confidencePct ?? 50) - (q.correct ? 100 : 0)), 0) / withConf.length,
		);
		return { bias, brier, accPct, n: withConf.length };
	};

	const buildSubjectDetail = (
		subjectName: string,
		readinessPct: number,
		readinessBaseline: boolean,
		graphConcepts: number,
		metrics?: LearningCapacityTelemetryInput["signals"]["learningProfile"] extends infer P
			? P extends { bySubject: Record<string, infer M> }
				? M
				: never
			: never,
	): SubjectLearningCapacityDetail => {
		const nk = normalizeSubjectKey(subjectName);
		const qMeta = quizBiasForSubject(subjectName);
		const subjProblems = practiceSamples.filter((p) => {
			const pk = normalizeSubjectKey(p.subject || p.sessionTitle);
			return Boolean(pk && (pk === nk || (p.subject && pk.includes(nk))));
		});
		const directSolvePct =
			metrics?.practiceSolveRatePct ??
			(subjProblems.length > 0
				? Math.round((subjProblems.filter((p) => p.outcome === "solved").length / subjProblems.length) * 100)
				: null);
		const subjDurs = subjProblems.map((p) => p.durationMin).filter((d): d is number => d !== null && d > 0);
		const directAvgMin =
			metrics?.avgMinutesPerProblem ??
			(subjDurs.length > 0 ? Math.round(subjDurs.reduce((a, v) => a + v, 0) / subjDurs.length) : null);

		const totalProbForSubj = Math.max(
			subjProblems.length,
			(metrics?.practiceSolvedCount ?? 0) + (metrics?.practiceHintsCount ?? 0) + (metrics?.practiceUnsolvedCount ?? 0),
		);
		let paceFactor = metrics?.paceFactor ?? 1.0;
		if (paceFactor === 1.0 && qMeta.n >= 4 && qMeta.accPct !== null && totalProbForSubj < 2 && (metrics?.fsrsReviews ?? 0) < 4) {
			const scale = Math.min(1, qMeta.n / 8);
			const quizAdj = (72 - qMeta.accPct) * 0.003 * scale;
			paceFactor = roundTo(clamp(1.0 + quizAdj, 0.78, 1.45), 2);
		}
		const sampleCount = (metrics?.fsrsReviews ?? 0) + totalProbForSubj + qMeta.n;
		const recallEvidence = input.recallBySubject?.[nk] ?? { responses: 0, assessed: 0, correct: 0, partial: 0, wrong: 0, dontKnow: 0, uncertain: 0 };
		return {
			subject: subjectName,
			readinessPct,
			readinessBaseline,
			reviewedConcepts: metrics?.fsrsTrackedNodes ?? 0,
			graphConcepts,
			retentionPct: metrics?.retentionRatePct ?? null,
			avgStabilityDays: metrics?.avgStabilityDays ?? null,
			avgDifficulty: metrics?.avgDifficulty ?? null,
			solveRatePct: directSolvePct,
			avgMinPerProblem: directAvgMin,
			quizBiasPct: qMeta.bias,
			brierScore: qMeta.brier,
			paceFactor,
			paceBaseline: (metrics?.fsrsReviews ?? 0) < 4 && totalProbForSubj < 2 && qMeta.n < 4,
			sampleCount,
			recallEvidence,
			recallInsights: summarizeRecallObservations(input.recallObservationsBySubject?.[nk] ?? [], now),
			recallCapacity: computeRecallCapacity(input.recallObservationsBySubject?.[nk] ?? [], now, recallOverlap),
		};
	};

	for (const sig of signals.subjectSignals) {
		const key = normalizeSubjectKey(sig.label);
		if (seenSubjKeys.has(key)) continue;
		seenSubjKeys.add(key);
		const metrics = lp?.bySubject[sig.label];
		subjectBreakdown.push(buildSubjectDetail(sig.label, sig.readinessPct, (metrics?.fsrsTrackedNodes ?? 0) === 0, sig.nodeCount, metrics));
	}

	if (lp) {
		for (const metrics of Object.values(lp.bySubject)) {
			const nk = normalizeSubjectKey(metrics.subject);
			if (seenSubjKeys.has(nk)) continue;
			const detail = buildSubjectDetail(metrics.subject, 35, true, 0, metrics);
			if (detail.sampleCount === 0 && metrics.loggedPlannerMinutes === 0 && detail.recallEvidence.responses === 0 && detail.recallEvidence.assessed === 0) continue;
			seenSubjKeys.add(nk);
			subjectBreakdown.push(detail);
		}
	}

	for (const [key, rows] of Object.entries(input.recallObservationsBySubject ?? {})) {
		if (!seenSubjKeys.has(key) && rows[0]) subjectBreakdown.push(buildSubjectDetail(rows[0].subject, 35, true, 0));
	}
	const { score, ...recallContribution } = recallCompositeAdjustment(compositeScore, subjectBreakdown.flatMap((row) => row.recallCapacity ? [row.recallCapacity] : []));

	subjectBreakdown.sort((a, b) => b.sampleCount - a.sampleCount || b.paceFactor - a.paceFactor);

	// ── Concrete Highlights Linking Graph + Sessions + FSRS ────────────────────
	const personalHighlights: string[] = [];
	if (avgStabilityDays !== null && passGoodEasyPct !== null) {
		personalHighlights.push(
			`Trí nhớ FSRS: trung bình ổn định ${avgStabilityDays} ngày (${passGoodEasyPct}% pass across ${fsrsReviewCount} lượt ôn)${hasCustomWeights ? ", dùng 21 trọng số tối ưu cá nhân" : ""}.`,
		);
	}
	if (confSamples.length >= 2 && calibrationBiasPct !== null) {
		personalHighlights.push(
			`Độ tự nhận thức (Metacognition): Brier ${brierScore}, lệch tự tin ${calibrationBiasPct > 0 ? `+${calibrationBiasPct}%` : `${calibrationBiasPct}%`} trên ${confSamples.length} câu hỏi có chấm độ tự tin.`,
		);
	}
	if (totalWeakFoundations + totalPrereqRisk > 0) {
		personalHighlights.push(
			`Rủi ro nền tảng Graph: ${totalWeakFoundations} khái niệm nền suy giảm · ${totalPrereqRisk} nhánh kiến thức bị ảnh hưởng tiền đề.`,
		);
	}
	if (avgMinProb !== null && rawSolveRatePct !== null) {
		personalHighlights.push(
			`Tốc độ giải quyết bài toán: ~${avgMinProb} phút/bài, tỷ lệ tự giải ${rawSolveRatePct}%${avgHintRung !== null ? ` (gợi ý TB R${avgHintRung})` : ""}.`,
		);
	}
	if (effectiveRules.length > 0) {
		personalHighlights.push(`Pattern lỗi gần nhất cần cảnh giác: ${effectiveRules[0]}`);
	}

	return {
		generatedAt: new Date(now).toISOString(),
		compositeScore: score,
		legacyCompositeScore: compositeScore,
		recallContribution,
		tierLabel: tierFor(score),
		confidenceLevel,
		recommendedPaceFactor,
		recommendedRealismFactor,
		recommendedDailyHours: lp?.sustainableDailyHours ?? null,
		dataCoverage: {
			fsrsReviews: fsrsReviewCount,
			trackedPropositions: nodeValues.length,
			hasCustomFsrsWeights: hasCustomWeights,
			...(w20 !== undefined ? { fsrsDecayW20: w20 } : {}),
			...(w3 !== undefined ? { fsrsInitEasyW3: w3 } : {}),
			graphNodes: totalGraphNodes,
			graphChains: input.graphChainCount ?? 0,
			quizSamples: quizSamples.length,
			quizConfidenceSamples: confSamples.length,
			practiceProblems: totalProbSamples,
			...(input.recallExplainCount !== undefined ? { recallExplainCount: input.recallExplainCount } : {}),
			mistakeRecords: analyzedErrCount,
			pastChatSessions: input.pastChatSessionCount ?? signals.recentSessions.length,
			loggedPlannerDays: allLogs.length,
		},
		metacognition: {
			sampleCount: confSamples.length,
			brierScore,
			calibrationBiasPct,
			biasDirection,
			dontKnowRatePct,
		},
		errorProfile: {
			totalAnalyzed: analyzedErrCount,
			schemaGapPct,
			slipRatePct,
			topErrorType,
			recentRules: effectiveRules,
		},
		dimensions,
		subjectBreakdown,
		personalHighlights: personalHighlights.slice(0, 5),
	};
}

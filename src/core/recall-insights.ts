export type RecallVerdict = "correct" | "partial" | "wrong" | "dont_know" | "uncertain";
export type RecallHelp = "independent" | "assisted" | "unknown";

export interface RecallObservation {
	id: string;
	chatId: string;
	sourceMessageId?: string;
	toolCallId?: string;
	subject: string;
	answeredAt: string;
	verdict?: RecallVerdict;
	source?: "ai" | "user";
	topic?: string;
	errorType?: string;
	elapsedMs?: number;
	timerMs?: number;
	help?: RecallHelp;
	staleAssessment?: boolean;
}

export interface RecallWindow {
	responses: number;
	assessed: number;
	needsReview: number;
	staleExamples: Array<{ chatId: string; sourceMessageId?: string; toolCallId?: string }>;
	correct: number;
	partial: number;
	wrong: number;
	dontKnow: number;
	uncertain: number;
	ai: number;
	confirmed: number;
	days: number;
	medianElapsedMin: number | null;
	elapsedCount: number;
	elapsedOver3h: number;
	medianTimerMin: number | null;
	timerCount: number;
	independent: number;
	assisted: number;
	helpUnknown: number;
}

export interface RecallSubjectInsights {
	last30: RecallWindow;
	previous30: RecallWindow;
	allTime: RecallWindow;
	trend: { correctRateDelta: number; partialRateDelta: number } | null;
	patterns: RecallPattern[];
	allTimePatterns: RecallPattern[];
}
export type RecallPattern = { topic: string; errorType: string; count: number; examples: Array<{ chatId: string; sourceMessageId?: string; toolCallId?: string }> };

const median = (values: number[]) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
	return Math.round((sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2) / 6000) / 10;
};
const localDayKey = (value: string): string | null => {
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : null;
};

function summarize(items: readonly RecallObservation[]): RecallWindow {
	const count = (verdict: RecallVerdict) => items.filter((item) => item.verdict === verdict).length;
	const elapsed = items.flatMap((item) => typeof item.elapsedMs === "number" && item.elapsedMs >= 0 ? [item.elapsedMs] : []);
	const timers = items.flatMap((item) => typeof item.timerMs === "number" && item.timerMs >= 0 ? [item.timerMs] : []);
	return {
		responses: items.length, assessed: items.filter((item) => Boolean(item.verdict)).length,
		needsReview: items.filter((item) => item.staleAssessment && !item.verdict).length,
		staleExamples: items.filter((item) => item.staleAssessment && !item.verdict).slice(0, 3).map(({ chatId, sourceMessageId, toolCallId }) => ({ chatId, sourceMessageId, toolCallId })),
		correct: count("correct"), partial: count("partial"), wrong: count("wrong"), dontKnow: count("dont_know"), uncertain: count("uncertain"),
		ai: items.filter((item) => item.source === "ai").length, confirmed: items.filter((item) => item.source === "user").length,
		days: new Set(items.map((item) => localDayKey(item.answeredAt)).filter(Boolean)).size,
		medianElapsedMin: median(elapsed), elapsedCount: elapsed.length, elapsedOver3h: elapsed.filter((value) => value > 3 * 3600_000).length,
		medianTimerMin: median(timers), timerCount: timers.length,
		independent: items.filter((item) => item.help === "independent").length, assisted: items.filter((item) => item.help === "assisted").length,
		helpUnknown: items.filter((item) => !item.help || item.help === "unknown").length,
	};
}

/** Descriptive evidence; not a validated ability score and never an FSRS rating. */
export function summarizeRecallObservations(items: readonly RecallObservation[], now: number): RecallSubjectInsights {
	const end = new Date(now); end.setHours(23, 59, 59, 999);
	const currentStart = new Date(end); currentStart.setHours(0, 0, 0, 0); currentStart.setDate(currentStart.getDate() - 29);
	const previousStart = new Date(currentStart); previousStart.setDate(previousStart.getDate() - 30);
	const current = items.filter((item) => { const at = Date.parse(item.answeredAt); return Number.isFinite(at) && at >= +currentStart && at <= +end; });
	const previous = items.filter((item) => { const at = Date.parse(item.answeredAt); return Number.isFinite(at) && at >= +previousStart && at < +currentStart; });
	const last30 = summarize(current), previous30 = summarize(previous), allTime = summarize(items);
	const rateDenom = (s: RecallWindow) => s.correct + s.partial + s.wrong + s.dontKnow;
	const gradedDays = (observations: readonly RecallObservation[]) => new Set(observations.filter((item) => item.verdict && item.verdict !== "uncertain").map((item) => localDayKey(item.answeredAt)).filter(Boolean)).size;
	const n1 = rateDenom(last30), n0 = rateDenom(previous30);
	const trend = n1 >= 5 && n0 >= 5 && gradedDays(current) >= 2 && gradedDays(previous) >= 2 ? {
		correctRateDelta: Math.round(last30.correct / n1 * 100 - previous30.correct / n0 * 100),
		partialRateDelta: Math.round(last30.partial / n1 * 100 - previous30.partial / n0 * 100),
	} : null;
	const patternsFor = (observations: readonly RecallObservation[]) => {
	const grouped = new Map<string, RecallPattern>();
	for (const item of observations) {
		if (!["partial", "wrong", "dont_know"].includes(item.verdict ?? "") || !item.topic?.trim()) continue;
		const topic = item.topic.trim(), errorType = item.errorType?.trim() || "unspecified", key = `${topic.toLocaleLowerCase()}\u0000${errorType}`;
		const group = grouped.get(key) ?? { topic, errorType, count: 0, examples: [] };
		group.count++; if (group.examples.length < 3) group.examples.push({ chatId: item.chatId, sourceMessageId: item.sourceMessageId, toolCallId: item.toolCallId }); grouped.set(key, group);
	}
	return [...grouped.values()].filter((item) => item.count >= 2).sort((a, b) => b.count - a.count).slice(0, 5);
	};
	return { last30, previous30, allTime, trend, patterns: patternsFor(current), allTimePatterns: patternsFor(items) };
}

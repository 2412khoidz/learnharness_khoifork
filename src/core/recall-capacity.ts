import type { RecallObservation } from "./recall-insights.ts";

export interface RecallRate {
	full: number;
	atLeastPartial: number;
}

export interface RecallCapacityProfile {
	responses: number;
	graded: number;
	uncertain: number;
	provisional: number;
	confirmed: number;
	assisted: number;
	helpUnknown: number;
	raw: RecallRate | null;
	estimate: RecallRate | null;
	confirmedEstimate: RecallRate | null;
	leaveOneDayOut: { full: [number, number]; atLeastPartial: [number, number] } | null;
	weighted: number;
	usable: number;
	days: number;
	overlapExcluded: number;
	overlapUnknown: number;
}

const DAY = 86_400_000;
const dayOf = (at: number) => {
	const date = new Date(at);
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
};

export const recallOutcome = (verdict: RecallObservation["verdict"]) =>
	verdict === "correct" ? 0 : verdict === "partial" ? 1 : verdict === "wrong" || verdict === "dont_know" ? 2 : null;

type Evidence = { row: RecallObservation; day: number; age: number; outcome: 0 | 1 | 2 };

function weightedRates(rows: readonly Evidence[]) {
	const counts = new Map<number, number>();
	for (const item of rows) counts.set(item.day, (counts.get(item.day) ?? 0) + 1);
	const mass = [0, 0, 0];
	for (const { row, day, age, outcome } of rows) {
		const source = row.source === "user" ? 1 : 0.5;
		const help = row.help === "independent" ? 1 : 0.5;
		mass[outcome]! += source * help * 2 ** (-age / 14) * Math.min(1, 3 / counts.get(day)!);
	}
	const weighted = mass.reduce((total, value) => total + value, 0);
	const estimate = weighted > 0 ? {
		full: (mass[0]! + 0.5) / (weighted + 1.5),
		atLeastPartial: (mass[0]! + mass[1]! + 1) / (weighted + 1.5),
	} : null;
	return { weighted, estimate };
}

/** A descriptive estimate of observed work, with a cap on a single day's evidence. */
export function computeRecallCapacity(
	observations: readonly RecallObservation[],
	now: number,
	exclude: ReadonlySet<string> = new Set(),
): RecallCapacityProfile {
	const sorted = observations
		.map((row) => ({ row, at: Date.parse(row.answeredAt) }))
		.filter(({ at }) => Number.isFinite(at) && at <= now && dayOf(now) - dayOf(at) < 30)
		.sort((a, b) => a.at - b.at || a.row.id.localeCompare(b.row.id));
	const ids = new Set<string>();
	const prompts = new Set<string>();
	const evidence: Evidence[] = [];
	const rawCounts = [0, 0, 0];
	let responses = 0, uncertain = 0, assisted = 0, helpUnknown = 0, confirmed = 0, provisional = 0;
	let overlapExcluded = 0, overlapUnknown = 0;
	for (const { row, at } of sorted) {
		if (ids.has(row.id)) continue;
		ids.add(row.id);
		responses++;
		if (row.help === "assisted") assisted++;
		if (!row.help || row.help === "unknown") helpUnknown++;
		if (row.staleAssessment) continue;
		if (row.verdict === "uncertain") uncertain++;
		const outcome = recallOutcome(row.verdict);
		if (outcome === null) continue;
		rawCounts[outcome]!++;
		if (row.source === "user") confirmed++;
		else provisional++;
		if (row.help === "assisted") continue;
		if (exclude.has(row.id)) {
			overlapExcluded++;
			continue;
		}
		if (!row.toolCallId) overlapUnknown++;
		const day = dayOf(at);
		if (row.promptKey) {
			const key = JSON.stringify([row.chatId, day, row.promptKey]);
			if (prompts.has(key)) continue;
			prompts.add(key);
		}
		evidence.push({ row, day, age: dayOf(now) - day, outcome });
	}
	const graded = rawCounts.reduce((sum, value) => sum + value, 0);
	const days = new Set(evidence.map((item) => item.day));
	const { weighted, estimate } = weightedRates(evidence);
	const sensitivity = days.size >= 3 ? [...days].map((day) => weightedRates(evidence.filter((item) => item.day !== day)).estimate!) : [];
	const range = (key: keyof RecallRate): [number, number] => {
		const values = sensitivity.map((rate) => rate[key]);
		return [Math.min(...values), Math.max(...values)];
	};
	return {
		responses, graded, uncertain, provisional, confirmed, assisted, helpUnknown, overlapExcluded, overlapUnknown,
		raw: graded ? { full: rawCounts[0]! / graded, atLeastPartial: (rawCounts[0]! + rawCounts[1]!) / graded } : null,
		estimate, weighted, usable: evidence.length, days: days.size,
		confirmedEstimate: weightedRates(evidence.filter(({ row }) => row.source === "user")).estimate,
		leaveOneDayOut: sensitivity.length ? { full: range("full"), atLeastPartial: range("atLeastPartial") } : null,
	};
}

export function recallCompositeAdjustment(baseline: number | null, subjects: readonly RecallCapacityProfile[]) {
	const active = subjects.filter((row) => row.responses > 0);
	const eligible = active.filter((row) => row.usable >= 5 && row.days >= 2 && row.estimate);
	const delta = baseline !== null && active.length ? 0.05 / active.length * eligible.reduce(
		(sum, row) => sum + row.weighted / (row.weighted + 8) * (100 * row.estimate!.full - baseline), 0,
	) : 0;
	return { delta, eligibleSubjects: eligible.length, activeSubjects: active.length, score: baseline === null ? null : Math.round(baseline + delta) };
}

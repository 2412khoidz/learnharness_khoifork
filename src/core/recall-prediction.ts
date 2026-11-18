import { recallOutcome } from "./recall-capacity.ts";
import type { RecallObservation } from "./recall-insights.ts";

const DAY = 86_400_000;
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

function dayKey(at: number) {
	const d = new Date(at);
	return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

export function probabilityLoss(rows: readonly { y: number; p: number }[]) {
	let brier = 0, logLoss = 0;
	for (const { y, p } of rows) {
		const bounded = Math.min(1 - 1e-6, Math.max(1e-6, p));
		brier += (p - y) ** 2;
		logLoss -= y ? Math.log(bounded) : Math.log1p(-bounded);
	}
	return { brier: brier / rows.length, logLoss: logLoss / rows.length };
}

export function recallPredictionRows(observations: readonly RecallObservation[], now: number) {
	const unique = new Set<string>();
	const eligible = observations.flatMap((row) => {
		const outcome = recallOutcome(row.verdict);
		const answered = Date.parse(row.answeredAt);
		const confirmed = row.confirmedAt ?? NaN;
		if (unique.has(row.id) || row.source !== "user" || row.help !== "independent" || row.staleAssessment ||
			outcome === null || !Number.isFinite(answered) || !Number.isFinite(confirmed) || confirmed < answered || confirmed > now) return [];
		unique.add(row.id);
		return [{ id: row.id, chatId: row.chatId, outcome, answered, confirmed, asked: row.askedAt ?? NaN }];
	});
	const byChat = new Map<string, typeof eligible>();
	for (const item of eligible) {
		const history = byChat.get(item.chatId) ?? [];
		history.push(item);
		byChat.set(item.chatId, history);
	}
	return eligible.flatMap((item) => {
		if (!Number.isFinite(item.asked) || item.asked > item.answered) return [];
		const history = byChat.get(item.chatId)!;
		const counts = [0, 0, 0, 0, 0, 0];
		for (const previous of history) {
			if (previous.id === item.id || previous.answered >= item.asked || previous.confirmed >= item.asked) continue;
			const age = item.asked - previous.answered;
			if (age <= 7 * DAY) counts[previous.outcome]!++;
			if (age <= 30 * DAY) counts[3 + previous.outcome]!++;
		}
		return [{ id: item.id, day: dayKey(item.asked), asked: item.asked, confirmed: item.confirmed, y: item.outcome === 0 ? 1 : 0, x: [1, ...counts.map(Math.log1p)] }];
	}).sort((a, b) => a.asked - b.asked || a.id.localeCompare(b.id));
}

export function evaluateRecallPrediction(observations: readonly RecallObservation[], now: number) {
	const rows = recallPredictionRows(observations, now);
	const insufficient = { status: "insufficient" as const, observations: rows.length };
	if (rows.length < 100) return insufficient;
	const cutoff = rows[rows.length - Math.max(20, Math.ceil(rows.length * 0.2))]!.day;
	const train = rows.filter((row) => row.day < cutoff && dayKey(row.confirmed) < cutoff);
	const test = rows.filter((row) => row.day >= cutoff);
	const full = train.filter((row) => row.y === 1).length;
	if (train.length < 80 || full < 30 || train.length - full < 30 || new Set(train.map((row) => row.day)).size < 5 ||
		test.length < 20 || !test.some((row) => row.y === 1) || !test.some((row) => row.y === 0)) return insufficient;
	const baseline = (full + 0.5) / (train.length + 1);
	const beta = [Math.log(baseline / (1 - baseline)), 0, 0, 0, 0, 0, 0];
	const predict = (x: number[]) => sigmoid(x.reduce((sum, value, j) => sum + value * beta[j]!, 0));
	// The Hessian norm is bounded by mean(||x||²)/4 plus the L2 penalty.
	const step = 1 / (train.reduce((sum, row) => sum + row.x.reduce((norm, x) => norm + x * x, 0), 0) / (4 * train.length) + 0.1);
	for (let iteration = 0; iteration < 400; iteration++) {
		const gradient = beta.map((value, j) => j === 0 ? 0 : 0.1 * value);
		for (const row of train) {
			const error = (predict(row.x) - row.y) / train.length;
			for (let j = 0; j < gradient.length; j++) gradient[j]! += error * row.x[j]!;
		}
		if (Math.max(...gradient.map(Math.abs)) < 1e-6) break;
		for (let j = 0; j < beta.length; j++) beta[j]! -= step * gradient[j]!;
	}
	const measured = probabilityLoss(test.map((row) => ({ y: row.y, p: predict(row.x) })));
	const reference = probabilityLoss(test.map((row) => ({ y: row.y, p: baseline })));
	const improved = measured.brier < reference.brier && measured.logLoss < reference.logLoss;
	const latest = observations.filter((row) => row.askedAt && row.askedAt < now)
		.reduce<RecallObservation | undefined>((last, row) => !last || row.askedAt! > last.askedAt! ? row : last, undefined);
	const probe = latest && recallPredictionRows([...observations, {
		...latest, id: "capacity-prediction", askedAt: now, answeredAt: new Date(now).toISOString(), confirmedAt: now,
		verdict: "correct", help: "independent", source: "user", staleAssessment: false,
	}], now).at(-1);
	return {
		status: improved ? "improved" as const : "baseline" as const,
		train: train.length, test: test.length, measured, reference,
		...(improved && probe?.id === "capacity-prediction" ? { next: { subject: latest!.subject, full: predict(probe.x) } } : {}),
	};
}

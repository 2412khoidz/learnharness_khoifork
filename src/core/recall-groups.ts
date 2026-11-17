import type { RecallObservation, RecallVerdict } from "./recall-insights.ts";

export type RecallGroupMember = { id: string; fingerprint: string };
export interface RecallGroup { id: string; name: string; reason: string; members: RecallGroupMember[]; model: string }
export interface RecallGroupView {
	id: string; name: string; reason: string; model: string; stale: boolean;
	count: number; distribution: Record<RecallVerdict, number>;
	answers: Array<{ id: string; chatId: string; sourceMessageId?: string; toolCallId?: string }>;
}
export type RecallGroupSource = { observation: RecallObservation; fingerprint: string };

/** Old or changed sources invalidate the whole group until it is reviewed again. */
export function projectRecallGroups(groups: readonly RecallGroup[], sources: readonly RecallGroupSource[], range: "allTime" | "last30", now: number): RecallGroupView[] {
	const current = new Map(sources.map((source) => [source.observation.id, source]));
	const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 29);
	const end = new Date(now); end.setHours(23, 59, 59, 999);
	return groups.map((group) => {
		const stale = group.members.some((member) => current.get(member.id)?.fingerprint !== member.fingerprint);
		const rows = group.members.flatMap((member) => { const source = current.get(member.id); if (!source) return []; const at = Date.parse(source.observation.answeredAt); return range === "allTime" || (Number.isFinite(at) && at >= +start && at <= +end) ? [source.observation] : []; });
		const distribution: Record<RecallVerdict, number> = { correct: 0, partial: 0, wrong: 0, dont_know: 0, uncertain: 0 };
		for (const row of rows) if (row.verdict) distribution[row.verdict]++;
		return { id: group.id, name: group.name, reason: group.reason, model: group.model, stale, count: rows.length, distribution, answers: rows.map(({ id, chatId, sourceMessageId, toolCallId }) => ({ id, chatId, sourceMessageId, toolCallId })) };
	});
}

/** Reject duplicate membership instead of double-counting the same answer. */
export function validateRecallGroups(groups: readonly RecallGroup[], sources: readonly RecallGroupSource[]): string | null {
	if (groups.length > 100) return "Too many groups.";
	const byId = new Map(sources.map((source) => [source.observation.id, source]));
	const seen = new Set<string>(), groupIds = new Set<string>();
	for (const group of groups) {
		if (!group.id || groupIds.has(group.id) || !group.name.trim() || group.name.length > 160 || group.reason.length > 2000 || group.members.length < 2) return "Each group needs a distinct ID, a name and at least two answers.";
		groupIds.add(group.id);
		for (const member of group.members) {
			const source = byId.get(member.id);
			if (seen.has(member.id) || source?.fingerprint !== member.fingerprint) return "An answer is duplicated, unavailable or changed. Refresh before approving.";
			if (!source.observation.verdict || source.observation.staleAssessment) return "An answer needs a current assessment before it can be grouped.";
			seen.add(member.id);
		}
	}
	return null;
}

import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ModelRole } from "../../config.ts";
import { runSubmitAgent } from "../agent/subagents/submit-agent.ts";
import type { PiEngine } from "../agent/models.ts";
import { normalizeSubjectKey } from "../core/planner.ts";
import type { RecallGroup, RecallGroupSource } from "../core/recall-groups.ts";
import { retryIncompleteOnce, mappingErrorMessage } from "../core/recall-mapping.ts";
import { analystEngine } from "./mistake-analysis.ts";
import { listAvailablePlannerRoles, readPlannerLearningCapacityServer, resolvePlannerEngine } from "./planner.ts";
import { readRecallGroups, saveRecallGroups, saveRecallGroupDraft } from "./recall-groups-store.ts";

export const recallGroupEngineOverride: { current?: PiEngine } = {};
const LIMIT = 300;
const revisionOfGroups = (groups: readonly RecallGroup[]) => createHash("sha256").update(JSON.stringify(groups)).digest("hex");

function sourceFor(subject: string, offset = 0) {
	const capacity = readPlannerLearningCapacityServer();
	const exact = capacity.report.subjectBreakdown.find((row) => row.subject === subject);
	if (!exact) throw new Error("The subject is unavailable; refresh the report.");
	const sources = capacity.recallSources.filter((row) => normalizeSubjectKey(row.observation.subject) === normalizeSubjectKey(subject));
	const eligible = sources.filter(({ observation }) => observation.verdict && !observation.staleAssessment && (observation.topic?.trim() || observation.feedback?.trim()));
	return { sources, eligible: eligible.slice(offset, offset + LIMIT), totalEligible: eligible.length };
}

/** Returns the exact text and model inputs for display before any AI call. */
export function recallGroupPreview(subject: string, offset = 0) {
	if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw new Error("Invalid batch offset.");
	const { sources, eligible, totalEligible } = sourceFor(subject, offset);
	const roles = listAvailablePlannerRoles();
	const saved = readRecallGroups().find((entry) => entry.subject === subject);
	const toItem = ({ observation, fingerprint }: RecallGroupSource) => ({ id: observation.id, fingerprint, topic: observation.topic ?? "", errorType: observation.errorType ?? "", verdict: observation.verdict, source: observation.source, feedback: observation.feedback ?? "", needsReview: observation.staleAssessment ?? false, chatId: observation.chatId, sourceMessageId: observation.sourceMessageId, toolCallId: observation.toolCallId });
	return {
		subject, totalAnswers: sources.length, totalEligible, limit: LIMIT, offset,
		model: roles.find((entry) => entry.role === "analyst")?.modelLabel ?? "Analyst (not configured)",
		availableRoles: roles,
		items: eligible.map(toItem), allItems: sources.map(toItem),
		groups: saved?.groups ?? [], draft: saved?.draft ?? null, history: saved?.history ?? [], approvedRevision: revisionOfGroups(saved?.groups ?? []),
	};
}

const schema = Type.Object({ groups: Type.Array(Type.Object({ name: Type.String(), reason: Type.String(), answerIds: Type.Array(Type.String()) })) });
type Proposal = { groups: Array<{ name: string; reason: string; answerIds: string[] }> };

/** The client must present the preview before explicitly invoking this paid operation. */
export async function suggestRecallGroups(subject: string, expected: Array<{ id: string; fingerprint: string }>, preferredRole?: ModelRole, signal?: AbortSignal, offset = 0) {
	const preview = recallGroupPreview(subject, offset);
	if (!Array.isArray(expected) || expected.length !== preview.items.length || expected.some((item, index) => item.id !== preview.items[index]?.id || item.fingerprint !== preview.items[index]?.fingerprint)) throw new Error("The preview changed. Review the updated input before requesting suggestions.");
	if (preview.items.length < 2) throw new Error("At least two assessed answers with topic or feedback are needed.");
	if (preferredRole && !preview.availableRoles.some((entry) => entry.role === preferredRole)) throw new Error("The selected model is unavailable.");
	const resolved = preferredRole ? resolvePlannerEngine("coach", preferredRole) : null;
	if (preferredRole && resolved?.role !== preferredRole) throw new Error("The selected model is unavailable.");
	const engine = recallGroupEngineOverride.current ?? resolved?.engine ?? analystEngine();
	let model = preferredRole ? resolved!.modelLabel : preview.model;
	const groups: RecallGroup[] = [];
	const failures: Array<{ offset: number; count: number; error: string }> = [];
	// Short IDs and small independent batches bound output size. Successful
	// batches are persisted before requesting the next one.
	for (let offset = 0; offset < preview.items.length; offset += 20) {
		if (signal?.aborted) { failures.push({ offset, count: preview.items.length - offset, error: "Request cancelled." }); break; }
		const batch = preview.items.slice(offset, offset + 20);
		const allowed = new Map(batch.map((item, index) => [`a${index}`, item]));
		const call = () => runSubmitAgent<Proposal>({
			role: preferredRole ?? "analyst", engine, signal,
			toolName: "submit_recall_topic_groups", toolDescription: "Propose evidence-based groups of semantically related recall topics.", parameters: schema,
			fill: (value) => value as Proposal,
			systemPrompt: "Group answers only when their existing topic and feedback provide specific evidence that they concern the same mathematical concept or recurring gap. Related words alone are not enough. Do not merge distinct concepts. Leave ambiguous answers ungrouped. When source is user, the learner's verdict takes precedence and old AI feedback may conflict. Keep correct, partially correct, incorrect, did-not-know and uncertain assessments distinct; never turn them into a score or infer independence. Each answer may appear in at most one group. Use only the exact supplied IDs, at least two per group. Explain each proposal briefly in Vietnamese. The learner must inspect and approve the proposals.",
			prompt: JSON.stringify({ subject, assessments: batch.map(({ topic, errorType, verdict, source, feedback }, index) => ({ id: `a${index}`, topic, errorType, verdict, source, feedback })) }),
			onStep: (_usage, label) => { model = label; }, neverSubmitted: "The model did not submit groups.",
			validate: (value) => {
				const seen = new Set<string>();
				for (const group of value.groups) {
					if (!group.name.trim() || !group.reason.trim() || group.answerIds.length < 2) return "Every group needs a name, a reason, and at least two answers.";
					for (const id of group.answerIds) { if (!allowed.has(id) || seen.has(id)) return "Use only supplied answer IDs, at most once."; seen.add(id); }
				}
				return null;
			},
		});
		try {
			const result = await retryIncompleteOnce(call, signal);
			const latest = recallGroupPreview(subject, offset + (preview.offset || 0));
			if (batch.some((item, index) => item.id !== latest.items[index]?.id || item.fingerprint !== latest.items[index]?.fingerprint)) throw new Error("The source assessments changed; review the preview again.");
			groups.push(...result.groups.map((group) => ({ id: randomUUID(), name: group.name.trim().slice(0, 160), reason: group.reason.trim().slice(0, 2000), model, members: group.answerIds.map((id) => ({ id: allowed.get(id)!.id, fingerprint: allowed.get(id)!.fingerprint })) })));
			const { sources } = sourceFor(subject);
			saveRecallGroupDraft(subject, groups, sources, undefined, model);
		} catch (error) {
			failures.push({ offset, count: batch.length, error: error instanceof Error && error.message.startsWith("The source assessments changed") ? error.message : mappingErrorMessage(error, signal) });
			break;
		}
	}
	return { groups, model, failures };
}

/** Saves only reviewed groups; does not touch questions, graph, plan or FSRS. */
export function approveRecallGroups(subject: string, groups: RecallGroup[], expectedRevision: string) {
	const { sources } = sourceFor(subject);
	const current = readRecallGroups().find((entry) => entry.subject === subject)?.groups ?? [];
	if (expectedRevision !== revisionOfGroups(current)) throw new Error("Approved groups changed elsewhere. Reload before saving.");
	if (!Array.isArray(groups) || groups.some((group) => !group || typeof group.id !== "string" || typeof group.name !== "string" || typeof group.reason !== "string" || typeof group.model !== "string" || !Array.isArray(group.members) || group.members.some((member) => !member || typeof member.id !== "string" || typeof member.fingerprint !== "string"))) throw new Error("Invalid groups.");
	saveRecallGroups(subject, groups, sources);
	return { saved: groups.length };
}

export function saveRecallGroupsDraft(subject: string, groups: RecallGroup[]) {
	const { sources } = sourceFor(subject);
	if (!Array.isArray(groups) || groups.some((group) => !group || typeof group.id !== "string" || typeof group.name !== "string" || typeof group.reason !== "string" || typeof group.model !== "string" || !Array.isArray(group.members) || group.members.some((member) => !member || typeof member.id !== "string" || typeof member.fingerprint !== "string"))) throw new Error("Invalid groups.");
	saveRecallGroupDraft(subject, groups, sources);
	return { saved: groups.length };
}

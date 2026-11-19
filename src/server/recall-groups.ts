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
const LIMIT = 100000;
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
	const roles = listAvailablePlannerRoles().map((entry) => {
		const cost = resolvePlannerEngine("coach", entry.role)?.engine.model.cost;
		return { ...entry, pricing: cost && Number.isFinite(cost.input) && Number.isFinite(cost.output) && cost.input > 0 && cost.output > 0 ? { input: cost.input, output: cost.output } : null };
	});
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

export type RecallGroupItem = ReturnType<typeof recallGroupPreview>["items"][number];
export function recallGroupSourceSnapshot(subject: string) { return sourceFor(subject).sources; }

/** Keep later requests bounded while giving related earlier topics first chance. */
function relevantPriorGroups(batch: RecallGroupItem[], groups: RecallGroup[]): RecallGroup[] {
 const words = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
 const current = new Set(batch.flatMap((item) => words(`${item.topic} ${item.feedback}`)));
 const ranked = groups.map((group, index) => ({ group, index, score: new Set(words(`${group.name} ${group.reason.slice(0, 200)}`).filter((word) => current.has(word))).size }))
  .sort((a, b) => b.score - a.score || a.index - b.index);
 const selected: RecallGroup[] = [];
 let chars = 0;
 for (const { group } of ranked) {
  const size = group.name.length + Math.min(group.reason.length, 200) + 40;
  if (selected.length >= 30 || chars + size > 6000) continue;
  selected.push(group); chars += size;
 }
 return selected;
}

/** One bounded request. IDs are aliases, so user records never need to be echoed by the model. */
export async function suggestRecallGroupBatch(subject: string, batch: RecallGroupItem[], engine: PiEngine, role: ModelRole, signal?: AbortSignal, onStep?: (usage: { input: number; output: number }, label: string) => void, priorGroups: RecallGroup[] = []) {
 const allowed = new Map(batch.map((item, index) => [`a${index}`, item]));
 const prior = new Map(relevantPriorGroups(batch, priorGroups).map((group, index) => [`p${index}`, group]));
 let model = `${engine.model.provider}:${engine.model.id}`;
 const result = await runSubmitAgent<Proposal>({
  role, engine, signal, maxTurns: 2,
  toolName: "submit_recall_topic_groups", toolDescription: "Propose evidence-based groups of semantically related recall topics.", parameters: schema,
  fill: (value) => value as Proposal,
  systemPrompt: "Group answers only when their existing topic and feedback provide specific evidence that they concern the same concept or recurring gap. Related words alone are not enough. Do not merge distinct concepts. Leave ambiguous answers ungrouped. Learner corrections take precedence. Keep correct, partial, wrong, did-not-know and uncertain distinct; never infer independence. An answer may belong to several genuinely distinct topics; avoid duplicate groups. Use only supplied IDs, at least two distinct answers per group. Previous group IDs represent all answers in that group; use them only when new answers genuinely belong to that topic. Explain briefly in Vietnamese. All suggestions require learner approval.",
  prompt: JSON.stringify({ subject, previousGroups: [...prior].map(([id, group]) => ({ id, name: group.name, reason: group.reason.slice(0, 200) })), assessments: batch.map(({ topic, errorType, verdict, source, feedback }, index) => ({ id: `a${index}`, topic, errorType, verdict, source, feedback })) }),
  onStep: (usage, label) => { model = label; onStep?.(usage, label); }, neverSubmitted: "The model did not submit groups.",
   validate: (value) => {
    for (const group of value.groups) {
     const seen = new Set<string>();
     if (!group.name.trim() || !group.reason.trim() || group.answerIds.length < 2) return "Every group needs a name, a reason, and at least two answers.";
     if (!group.answerIds.some((id) => allowed.has(id))) return "Every group must include at least one answer from the current batch.";
     for (const id of group.answerIds) { if ((!allowed.has(id) && !prior.has(id)) || seen.has(id)) return "Use only supplied answer IDs, at most once within each group."; seen.add(id); }
    }
    return null;
   },
 });
 return { model, groups: result.groups.map((group) => ({ id: randomUUID(), name: group.name.trim().slice(0, 160), reason: group.reason.trim().slice(0, 2000), model, members: [...new Map(group.answerIds.flatMap((id) => { const old = prior.get(id); const current = allowed.get(id); return old ? old.members : current ? [{ id: current.id, fingerprint: current.fingerprint }] : []; }).map((member) => [member.id, member])).values()] })).filter((group) => group.members.length >= 2) };
}

/** Backward-compatible single request; newer UI uses a persisted group job. */
export async function suggestRecallGroups(subject: string, expected: Array<{ id: string; fingerprint: string }>, preferredRole?: ModelRole, signal?: AbortSignal, offset = 0) {
 const preview = recallGroupPreview(subject, offset);
 if (!Array.isArray(expected) || expected.length !== preview.items.length || expected.some((item, index) => item.id !== preview.items[index]?.id || item.fingerprint !== preview.items[index]?.fingerprint)) throw new Error("The preview changed. Review the updated input before requesting suggestions.");
 if (preview.items.length < 2) throw new Error("At least two assessed answers with topic or feedback are needed.");
 if (preferredRole && !preview.availableRoles.some((entry) => entry.role === preferredRole)) throw new Error("The selected model is unavailable.");
 const resolved = preferredRole ? resolvePlannerEngine("coach", preferredRole) : null;
 if (preferredRole && resolved?.role !== preferredRole) throw new Error("The selected model is unavailable.");
 const engine = recallGroupEngineOverride.current ?? resolved?.engine ?? analystEngine();
 let model = preferredRole ? resolved!.modelLabel : preview.model;
 const groups: RecallGroup[] = [], failures: Array<{ offset: number; count: number; error: string }> = [];
 const sources = recallGroupSourceSnapshot(subject);
 for (let index = 0; index < preview.items.length; index += 20) {
  if (signal?.aborted) { failures.push({ offset: index, count: preview.items.length - index, error: "Request cancelled." }); break; }
  const batch = preview.items.slice(index, index + 20);
  if (batch.length < 2) break;
  try { const result = await retryIncompleteOnce(() => suggestRecallGroupBatch(subject, batch, engine, preferredRole ?? "analyst", signal), signal); model = result.model; groups.push(...result.groups); saveRecallGroupDraft(subject, groups, sources, undefined, model); }
  catch (error) { failures.push({ offset: index, count: batch.length, error: mappingErrorMessage(error, signal) }); break; }
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

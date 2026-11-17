import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS, type ModelRole } from "../../config.ts";
import type { RecallScanResult } from "../core/mistakes.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { readMistakes, writeMistakes } from "../store/mistakes.ts";
import { assessRecallBatch, recallAuditCandidates, recallScanStatus, liveRecallGrades } from "./recall-scan.ts";
import { analystEngine } from "./mistake-analysis.ts";
import { listAvailablePlannerRoles, resolvePlannerEngine } from "./planner.ts";
import { readRecallOverrides, recallFingerprint, type RecallOverride } from "./recall-overrides.ts";
import { mappingErrorMessage, isIncompleteProviderResponse } from "../core/recall-mapping.ts";

type Candidate = ReturnType<typeof recallAuditCandidates>[number];
type Result = { id: string; fingerprint: string; proposal: RecallScanResult; originalVerdict: string | null; originalSource: string; originalFeedback: string; originalAssessment?: Pick<RecallScanResult, "strengths" | "missing" | "correction" | "evidence">; originalMistake?: ReturnType<typeof readMistakes>[number]; mistakeExists: boolean; model: string; assessedAt: string; applied?: boolean };
type Review = { id: string; before: RecallOverride | null; after: RecallOverride; removedMistake?: ReturnType<typeof readMistakes>[number] };
interface AuditRun { id: string; createdAt: string; model: string; role?: ModelRole; status: "running" | "paused" | "complete" | "error"; items: Array<{ id: string; fingerprint: string }>; results: Result[]; reviews: Array<{ id: string; at: string; entries: Review[]; undoneAt?: string; pending?: boolean }>; usage: { input: number; output: number; calls: number }; error?: string }
const file = () => path.join(PATHS.data, "recall-audits.json");
function read(): AuditRun[] {
 try { const data: unknown = JSON.parse(fs.readFileSync(file(), "utf8")); if (!data || typeof data !== "object" || (data as { version?: number }).version !== 1 || !Array.isArray((data as { runs?: unknown }).runs)) throw new Error("Invalid audit data."); return (data as { runs: AuditRun[] }).runs; }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function write(runs: AuditRun[]) { fs.mkdirSync(PATHS.data, { recursive: true }); writeFileAtomicSync(file(), JSON.stringify({ version: 1, runs }), { allowInPlaceFallback: true }); }
const active = () => { const g = globalThis as typeof globalThis & { __lhRecallAudit?: Map<string, AbortController> }; return g.__lhRecallAudit ??= new Map(); };
function saveRun(run: AuditRun) { const all = read(); write([...all.filter((entry) => entry.id !== run.id), run]); }
function sources() {
 const candidates = recallAuditCandidates();
 const scan = new Map(recallScanStatus().results.map((item) => [item.id, item]));
 const overrides = new Map(readRecallOverrides().map((item) => [item.id, item]));
 const liveByChat = new Map<string, Map<string, RecallScanResult>>();
 const mistakes = new Map(readMistakes().map((item) => [item.id, item]));
 return candidates.map((item) => {
  let live = liveByChat.get(item.draft.chatId);
  if (!live) { live = new Map(liveRecallGrades(item.draft.chatId).map((entry) => [entry.id, entry])); liveByChat.set(item.draft.chatId, live); }
  const fingerprint = recallFingerprint(item.draft), prior = live.get(item.draft.id) ?? scan.get(item.draft.id);
  const validPrior = prior && recallFingerprint(prior.draft) === fingerprint ? prior : undefined;
  const correction = overrides.get(item.draft.id);
  const validCorrection = correction?.fingerprint === fingerprint ? correction : undefined;
  return { ...item, fingerprint, originalVerdict: validCorrection?.verdict ?? validPrior?.verdict ?? null, originalSource: validCorrection?.verdict ? "user" : validPrior ? "ai" : "unassessed", originalAssessment: validPrior ? { strengths: validPrior.strengths, missing: validPrior.missing, correction: validPrior.correction, evidence: validPrior.evidence } : undefined, mistake: mistakes.get(item.draft.id) ?? null };
 });
}
export const recallAuditEngineOverride: { current?: import("../agent/models.ts").PiEngine } = {};
export function recallAuditPreview() {
 const items = sources();
 const roles = listAvailablePlannerRoles();
 return { items, count: items.length, roles, model: roles.find((entry) => entry.role === "analyst")?.modelLabel ?? "Analyst", estimate: "Cost depends on the selected model and response length; the exact price is not available here." };
}
export function recallAudits() { return read().map((run) => ({ ...run, status: run.status === "running" && !active().has(run.id) ? "paused" as const : run.status })); }
export function startRecallAudit(input: { role?: ModelRole; expected: Array<{ id: string; fingerprint: string }> }) {
 if (active().size) throw new Error("An audit is already running.");
 const items = sources();
 if (!Array.isArray(input.expected) || input.expected.length !== items.length || items.some((item, i) => input.expected[i]?.id !== item.draft.id || input.expected[i]?.fingerprint !== item.fingerprint)) throw new Error("The answers changed. Review the updated preview first.");
 if (!items.length) throw new Error("No recall answers are available.");
 const roles = listAvailablePlannerRoles();
 if (input.role && !roles.some((entry) => entry.role === input.role)) throw new Error("The selected model is unavailable.");
 const resolved = input.role ? resolvePlannerEngine("coach", input.role) : null;
 if (input.role && resolved?.role !== input.role) throw new Error("The selected model is unavailable.");
 const engine = recallAuditEngineOverride.current ?? resolved?.engine ?? analystEngine();
 const run: AuditRun = { id: randomUUID(), createdAt: new Date().toISOString(), model: input.role ? resolved!.modelLabel : roles.find((entry) => entry.role === "analyst")?.modelLabel ?? "Analyst", role: input.role, status: "paused", items: items.map((item) => ({ id: item.draft.id, fingerprint: item.fingerprint })), results: [], reviews: [], usage: { input: 0, output: 0, calls: 0 } };
 saveRun(run); launch(run, engine); return run;
}
export function resumeRecallAudit(id: string, role?: ModelRole) {
 if (active().size) throw new Error("An audit is already running.");
 const run = read().find((entry) => entry.id === id); if (!run) throw new Error("Audit not found.");
 if (run.reviews.some((review) => review.pending)) throw new Error("A previous review needs recovery before resuming.");
 if (role && !listAvailablePlannerRoles().some((entry) => entry.role === role)) throw new Error("The selected model is unavailable.");
 const selectedRole = role ?? run.role;
 const resolved = selectedRole ? resolvePlannerEngine("coach", selectedRole) : null;
 if (selectedRole && resolved?.role !== selectedRole) throw new Error("The selected model is unavailable.");
 const engine = recallAuditEngineOverride.current ?? resolved?.engine ?? analystEngine();
 if (role) { run.role = role; run.model = resolved!.modelLabel; }
 launch(run, engine); return run;
}
function launch(run: AuditRun, engine: import("../agent/models.ts").PiEngine) {
 const controller = new AbortController(); active().set(run.id, controller); run.status = "running"; run.error = undefined; saveRun(run);
 void (async () => {
  try {
   const all = new Map(sources().map((item) => [item.draft.id, item]));
   const done = new Set(run.results.map((item) => item.id));
   const work = run.items.filter((item) => !done.has(item.id));
   for (let i = 0; i < work.length; i += 5) {
    if (controller.signal.aborted) break;
    const part = work.slice(i, i + 5);
    const batch = part.map((entry) => all.get(entry.id));
    if (batch.some((item, index) => !item || item.fingerprint !== part[index]!.fingerprint)) throw new Error("An answer changed since this audit began; start a new audit to review it.");
    const assessPart = async (subset: NonNullable<typeof batch[number]>[], split: boolean): Promise<void> => {
     if (controller.signal.aborted) return;
     try {
      const grades = await assessRecallBatch(subset as Candidate[], engine, controller.signal, (usage) => { run.usage.input += usage.input || 0; run.usage.output += usage.output || 0; run.usage.calls++; saveRun(run); }, new Map(subset.map((item) => [item.draft.id, { verdict: item.originalVerdict, source: item.originalSource, assessment: item.originalAssessment, mistakeAnalysis: item.mistake?.analysis }])));
      if (controller.signal.aborted) return;
      for (const grade of grades) {
       const source = subset.find((item) => item.draft.id === grade.id)!;
       run.results.push({ id: grade.id, fingerprint: source.fingerprint, proposal: { ...grade, draft: source.draft, sessionTitle: source.sessionTitle }, originalVerdict: source.originalVerdict, originalSource: source.originalSource, originalFeedback: source.feedback ?? "", originalAssessment: source.originalAssessment, originalMistake: source.mistake ?? undefined, mistakeExists: Boolean(source.mistake), model: run.model, assessedAt: new Date().toISOString() });
      }
      saveRun(run);
     } catch (error) {
      if (!split && !controller.signal.aborted && isIncompleteProviderResponse(error) && subset.length > 1) {
       const middle = Math.ceil(subset.length / 2); await assessPart(subset.slice(0, middle), true); await assessPart(subset.slice(middle), true); return;
      }
      throw error;
     }
    };
    await assessPart(batch as NonNullable<typeof batch[number]>[], false);
   }
   run.status = controller.signal.aborted ? "paused" : "complete";
  } catch (error) { run.status = controller.signal.aborted ? "paused" : "error"; run.error = error instanceof Error && error.message.startsWith("An answer changed") ? error.message : mappingErrorMessage(error, controller.signal); }
  finally { active().delete(run.id); saveRun(run); }
 })();
}
export function pauseRecallAudit(id: string) { active().get(id)?.abort(); return recallAudits().find((run) => run.id === id); }

/** Explicit review changes recall overrides and optionally archives selected mistakes.
 * The original records are retained in the audit ledger for undo. */
export function applyRecallAudit(id: string, choices: Array<{ id: string; removeMistake?: boolean }>) {
 const run = read().find((entry) => entry.id === id); if (!run || active().has(id)) throw new Error("Pause the audit before applying reviews.");
 if (!Array.isArray(choices) || !choices.length || choices.length > 100 || new Set(choices.map((item) => item.id)).size !== choices.length) throw new Error("Select 1 to 100 different answers.");
 if (run.reviews.some((review) => review.pending)) throw new Error("A previous review needs recovery.");
 const current = new Map(sources().map((item) => [item.draft.id, item]));
 const existing = readRecallOverrides(), mistakes = readMistakes(), now = new Date().toISOString();
 const entries: Review[] = choices.map((choice) => {
  const result = run.results.find((item) => item.id === choice.id), source = current.get(choice.id);
  if (!result || result.applied || !source || source.fingerprint !== result.fingerprint) throw new Error("An answer changed or was already applied. Refresh before reviewing.");
  const before = existing.find((item) => item.id === choice.id) ?? null;
  if ((source.originalVerdict !== result.originalVerdict || source.originalSource !== result.originalSource)) throw new Error("An assessment changed since the audit. Review it again.");
  const after: RecallOverride = { ...(before ?? { id: choice.id, fingerprint: result.fingerprint }), fingerprint: result.fingerprint, verdict: result.proposal.verdict, updatedAt: now };
  const mistake = mistakes.find((item) => item.id === choice.id);
  if (choice.removeMistake && (result.proposal.verdict !== "correct" || !mistake)) throw new Error("Only an existing mistake assessed correct can be removed.");
  return { id: choice.id, before, after, ...(choice.removeMistake && mistake ? { removedMistake: mistake } : {}) };
 });
 const review = { id: randomUUID(), at: now, entries, pending: true }; run.reviews.push(review); saveRun(run);
 const ids = new Set(entries.map((entry) => entry.id));
 writeFileAtomicSync(path.join(PATHS.data, "recall-overrides.json"), JSON.stringify({ version: 1, entries: [...existing.filter((item) => !ids.has(item.id)), ...entries.map((entry) => entry.after)] }), { allowInPlaceFallback: true });
 if (entries.some((entry) => entry.removedMistake)) { const removed = new Set(entries.filter((entry) => entry.removedMistake).map((entry) => entry.id)); writeMistakes(mistakes.filter((item) => !removed.has(item.id))); }
 for (const result of run.results) if (ids.has(result.id)) result.applied = true;
 review.pending = false; saveRun(run); return { applied: entries.length, reviewId: review.id };
}
export function undoRecallAudit(id: string, reviewId: string) {
 const run = read().find((entry) => entry.id === id), review = run?.reviews.find((entry) => entry.id === reviewId);
 if (!run || !review || review.undoneAt || active().has(id)) throw new Error("This review cannot be undone.");
 const existing = readRecallOverrides(), mistakes = readMistakes();
 for (const entry of review.entries) {
  const current = existing.find((item) => item.id === entry.id) ?? null;
  if (JSON.stringify(current) !== JSON.stringify(entry.after) && !(review.pending && JSON.stringify(current) === JSON.stringify(entry.before))) throw new Error("An assessment changed after this review; undo would overwrite it.");
  const currentMistake = mistakes.find((item) => item.id === entry.id);
  if (entry.removedMistake && currentMistake && !(review.pending && JSON.stringify(currentMistake) === JSON.stringify(entry.removedMistake))) throw new Error("A removed mistake has been recreated; undo would overwrite it.");
 }
 const ids = new Set(review.entries.map((entry) => entry.id));
 writeFileAtomicSync(path.join(PATHS.data, "recall-overrides.json"), JSON.stringify({ version: 1, entries: [...existing.filter((item) => !ids.has(item.id)), ...review.entries.flatMap((entry) => entry.before ? [entry.before] : [])] }), { allowInPlaceFallback: true });
 const restored = review.entries.flatMap((entry) => entry.removedMistake && !mistakes.some((item) => item.id === entry.id) ? [entry.removedMistake] : []);
 if (restored.length) writeMistakes([...mistakes, ...restored]);
 review.pending = false; review.undoneAt = new Date().toISOString(); for (const result of run.results) if (ids.has(result.id)) result.applied = false; saveRun(run);
 return { undone: review.entries.length };
}

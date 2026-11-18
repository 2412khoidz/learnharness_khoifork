import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS, type ModelRole } from "../../config.ts";
import type { RecallScanResult } from "../core/mistakes.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { readMistakeDismissals, writeMistakeDismissals, mistakeSourceFingerprint, type MistakeDismissal } from "../store/mistake-dismissals.ts";
import { readMistakes, writeMistakes } from "../store/mistakes.ts";
import { assessRecallBatch, recallAuditCandidates, recallScanStatus, liveRecallGrades } from "./recall-scan.ts";
import { analystEngine } from "./mistake-analysis.ts";
import { listAvailablePlannerRoles, resolvePlannerEngine } from "./planner.ts";
import { readRecallOverrides, recallFingerprint, type RecallOverride } from "./recall-overrides.ts";
import { mappingErrorMessage, recallFailureKind, batchRecallBySize } from "../core/recall-mapping.ts";

type Candidate = ReturnType<typeof recallAuditCandidates>[number];
type Result = { id: string; fingerprint: string; proposal: RecallScanResult; originalVerdict: string | null; originalSource: string; originalFeedback: string; originalAssessment?: Pick<RecallScanResult, "strengths" | "missing" | "correction" | "evidence">; originalMistake?: ReturnType<typeof readMistakes>[number]; mistakeExists: boolean; model: string; assessedAt: string; applied?: boolean };
type Review = { id: string; before: RecallOverride | null; after: RecallOverride; removedMistake?: ReturnType<typeof readMistakes>[number]; dismissalBefore?: MistakeDismissal | null; dismissalAfter?: MistakeDismissal };
interface AuditRun { id: string; createdAt: string; model: string; role?: ModelRole; status: "running" | "paused" | "complete" | "error"; items: Array<{ id: string; fingerprint: string }>; results: Result[]; reviews: Array<{ id: string; at: string; entries: Review[]; undoneAt?: string; pending?: boolean }>; usage: { input: number; output: number; calls: number }; skipped?: Array<{ id: string; reason: string }>; error?: string }
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
 const roles = listAvailablePlannerRoles().map((entry) => {
  const cost = resolvePlannerEngine("coach", entry.role)?.engine.model.cost;
  const pricing = cost && Number.isFinite(cost.input) && Number.isFinite(cost.output) && cost.input > 0 && cost.output > 0 ? { input: cost.input, output: cost.output } : null;
  return { ...entry, pricing };
 });
 const inputCharacters = items.reduce((sum, item) => sum + JSON.stringify({ question: item.draft.question, answer: item.draft.yourAnswer, committed: item.draft.correctAnswer, thinking: item.draft.thinking, feedback: item.feedback }).length, 0);
 return { items, count: items.length, roles, inputCharacters, model: roles.find((entry) => entry.role === "analyst")?.modelLabel ?? "Analyst", estimate: "Cost depends on the selected model, output length and retries; catalog prices can be outdated." };
}
export function recallAudits() { return read().map((run) => ({ ...run, status: run.status === "running" && !active().has(run.id) ? "paused" as const : run.status })); }
export function recallAuditActivity() {
 const running = active();
 if (!running.size) return [];
 return read().filter((run) => running.has(run.id)).map((run) => ({ done: run.results.length, total: run.items.length }));
}
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
export function resumeRecallAudit(id: string, role?: ModelRole, retrySkipped = false) {
 if (active().size) throw new Error("An audit is already running.");
 const run = read().find((entry) => entry.id === id); if (!run) throw new Error("Audit not found.");
 if (run.reviews.some((review) => review.pending)) throw new Error("A previous review needs recovery before resuming.");
 if (role && !listAvailablePlannerRoles().some((entry) => entry.role === role)) throw new Error("The selected model is unavailable.");
 const selectedRole = role ?? run.role;
 const resolved = selectedRole ? resolvePlannerEngine("coach", selectedRole) : null;
 if (selectedRole && resolved?.role !== selectedRole) throw new Error("The selected model is unavailable.");
 const engine = recallAuditEngineOverride.current ?? resolved?.engine ?? analystEngine();
 if (role) { run.role = role; run.model = resolved!.modelLabel; }
 if (retrySkipped) run.skipped = [];
 launch(run, engine); return run;
}
function launch(run: AuditRun, engine: import("../agent/models.ts").PiEngine) {
 const controller = new AbortController(); active().set(run.id, controller); run.status = "running"; run.error = undefined; saveRun(run);
 void (async () => {
  try {
   const all = new Map(sources().map((item) => [item.draft.id, item]));
   const done = new Set([...run.results.map((item) => item.id), ...(run.skipped ?? []).map((item) => item.id)]);
   const work = run.items.filter((item) => !done.has(item.id));
   const batches = batchRecallBySize(work, (entry) => { const item = all.get(entry.id); return item ? JSON.stringify({ question: item.draft.question, answer: item.draft.yourAnswer, committed: item.draft.correctAnswer, thinking: item.draft.thinking, feedback: item.feedback }).length + 500 : 500; });
   for (const part of batches) {
    if (controller.signal.aborted) break;
    const batch = part.flatMap((entry) => {
     const item = all.get(entry.id);
     if (!item || item.fingerprint !== entry.fingerprint) { run.skipped ??= []; if (!run.skipped.some((skip) => skip.id === entry.id)) run.skipped.push({ id: entry.id, reason: "The original answer changed or is unavailable; review it again." }); return []; }
     return [item];
    });
    if (batch.length !== part.length) saveRun(run);
    if (!batch.length) continue;
    const assessPart = async (subset: NonNullable<typeof batch[number]>[], depth: number, transientRetried = false): Promise<void> => {
     if (controller.signal.aborted) return;
     try {
      const grades = await assessRecallBatch(subset as Candidate[], engine, controller.signal, (usage) => { run.usage.input += usage.input || 0; run.usage.output += usage.output || 0; run.usage.calls++; saveRun(run); }, new Map(subset.map((item) => [item.draft.id, { verdict: item.originalVerdict, source: item.originalSource, mistakeSummary: item.mistake?.analysis?.whatYouDid }])));
      if (controller.signal.aborted) return;
      for (const grade of grades) {
       const source = subset.find((item) => item.draft.id === grade.id)!;
       run.results.push({ id: grade.id, fingerprint: source.fingerprint, proposal: { ...grade, draft: source.draft, sessionTitle: source.sessionTitle }, originalVerdict: source.originalVerdict, originalSource: source.originalSource, originalFeedback: source.feedback ?? "", originalAssessment: source.originalAssessment, originalMistake: source.mistake ?? undefined, mistakeExists: Boolean(source.mistake), model: run.model, assessedAt: new Date().toISOString() });
      }
      saveRun(run);
     } catch (error) {
      const kind = recallFailureKind(error);
      if (controller.signal.aborted || kind === "cancelled" || kind === "auth" || kind === "quota") throw error;
      if (kind === "transient" && !transientRetried) { await assessPart(subset, depth, true); return; }
      if (kind === "split" && subset.length > 1 && depth < 4) {
       const middle = Math.ceil(subset.length / 2); await assessPart(subset.slice(0, middle), depth + 1); await assessPart(subset.slice(middle), depth + 1); return;
      }
      if (kind === "split") {
       run.skipped ??= [];
       for (const item of subset) if (!run.skipped.some((entry) => entry.id === item.draft.id)) run.skipped.push({ id: item.draft.id, reason: `Could not assess this answer (${kind}); retry it later or choose another model.` });
       saveRun(run); return;
      }
      throw error;
     }
    };
    await assessPart(batch as NonNullable<typeof batch[number]>[], 0);
   }
   run.status = controller.signal.aborted ? "paused" : "complete";
  } catch (error) { run.status = controller.signal.aborted ? "paused" : "error"; run.error = `${mappingErrorMessage(error, controller.signal)} (Category: ${recallFailureKind(error)}.)`; }
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
 const existing = readRecallOverrides(), mistakes = readMistakes(), dismissals = readMistakeDismissals(), now = new Date().toISOString();
 const entries: Review[] = choices.map((choice) => {
  const result = run.results.find((item) => item.id === choice.id), source = current.get(choice.id);
  if (!result || result.applied || !source || source.fingerprint !== result.fingerprint) throw new Error("An answer changed or was already applied. Refresh before reviewing.");
  const before = existing.find((item) => item.id === choice.id) ?? null;
  if ((source.originalVerdict !== result.originalVerdict || source.originalSource !== result.originalSource)) throw new Error("An assessment changed since the audit. Review it again.");
  const after: RecallOverride = { ...(before ?? { id: choice.id, fingerprint: result.fingerprint }), fingerprint: result.fingerprint, verdict: result.proposal.verdict, updatedAt: now };
  const mistake = mistakes.find((item) => item.id === choice.id);
  if (choice.removeMistake && (result.proposal.verdict !== "correct" || !mistake)) throw new Error("Only an existing mistake assessed correct can be removed.");
  return { id: choice.id, before, after, ...(choice.removeMistake && mistake ? { removedMistake: mistake, dismissalBefore: dismissals.find((entry) => entry.id === choice.id) ?? null, dismissalAfter: { id: choice.id, fingerprint: mistakeSourceFingerprint(mistake), dismissedAt: now } } : {}) };
 });
 const review = { id: randomUUID(), at: now, entries, pending: true }; run.reviews.push(review); saveRun(run);
 const ids = new Set(entries.map((entry) => entry.id));
 writeFileAtomicSync(path.join(PATHS.data, "recall-overrides.json"), JSON.stringify({ version: 1, entries: [...existing.filter((item) => !ids.has(item.id)), ...entries.map((entry) => entry.after)] }), { allowInPlaceFallback: true });
 if (entries.some((entry) => entry.removedMistake)) { const removed = new Set(entries.filter((entry) => entry.removedMistake).map((entry) => entry.id)); writeMistakeDismissals([...dismissals.filter((entry) => !removed.has(entry.id)), ...entries.flatMap((entry) => entry.dismissalAfter ? [entry.dismissalAfter] : [])]); writeMistakes(mistakes.filter((item) => !removed.has(item.id))); }
 for (const result of run.results) if (ids.has(result.id)) result.applied = true;
 review.pending = false; saveRun(run); return { applied: entries.length, reviewId: review.id };
}
export function undoRecallAudit(id: string, reviewId: string) {
 const run = read().find((entry) => entry.id === id), review = run?.reviews.find((entry) => entry.id === reviewId);
 if (!run || !review || review.undoneAt || active().has(id)) throw new Error("This review cannot be undone.");
 const existing = readRecallOverrides(), mistakes = readMistakes(), dismissals = readMistakeDismissals();
 for (const entry of review.entries) {
  const current = existing.find((item) => item.id === entry.id) ?? null;
  if (JSON.stringify(current) !== JSON.stringify(entry.after) && !(review.pending && JSON.stringify(current) === JSON.stringify(entry.before))) throw new Error("An assessment changed after this review; undo would overwrite it.");
  if (entry.dismissalAfter) { const currentDismissal = dismissals.find((item) => item.id === entry.id) ?? null; if (JSON.stringify(currentDismissal) !== JSON.stringify(entry.dismissalAfter) && !(review.pending && JSON.stringify(currentDismissal) === JSON.stringify(entry.dismissalBefore ?? null))) throw new Error("The mistake dismissal changed after this review; undo would overwrite it."); }
  const currentMistake = mistakes.find((item) => item.id === entry.id);
  if (entry.removedMistake && currentMistake && !(review.pending && JSON.stringify(currentMistake) === JSON.stringify(entry.removedMistake))) throw new Error("A removed mistake has been recreated; undo would overwrite it.");
 }
 const ids = new Set(review.entries.map((entry) => entry.id));
 writeFileAtomicSync(path.join(PATHS.data, "recall-overrides.json"), JSON.stringify({ version: 1, entries: [...existing.filter((item) => !ids.has(item.id)), ...review.entries.flatMap((entry) => entry.before ? [entry.before] : [])] }), { allowInPlaceFallback: true });
 const dismissalIds = new Set(review.entries.filter((entry) => entry.dismissalAfter).map((entry) => entry.id));
 if (dismissalIds.size) writeMistakeDismissals([...dismissals.filter((entry) => !dismissalIds.has(entry.id)), ...review.entries.flatMap((entry) => entry.dismissalBefore ? [entry.dismissalBefore] : [])]);
 const restored = review.entries.flatMap((entry) => entry.removedMistake && !mistakes.some((item) => item.id === entry.id) ? [entry.removedMistake] : []);
 if (restored.length) writeMistakes([...mistakes, ...restored]);
 review.pending = false; review.undoneAt = new Date().toISOString(); for (const result of run.results) if (ids.has(result.id)) result.applied = false; saveRun(run);
 return { undone: review.entries.length };
}

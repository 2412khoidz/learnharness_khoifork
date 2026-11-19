import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS, type ModelRole } from "../../config.ts";
import type { RecallGroup } from "../core/recall-groups.ts";
import { batchRecallBySize, recallFailureKind, mappingErrorMessage } from "../core/recall-mapping.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { analystEngine } from "./mistake-analysis.ts";
import { resolvePlannerEngine } from "./planner.ts";
import { recallGroupPreview, recallGroupSourceSnapshot, suggestRecallGroupBatch, recallGroupEngineOverride, type RecallGroupItem } from "./recall-groups.ts";
import { saveRecallGroupDraft } from "./recall-groups-store.ts";

type Item = { id: string; fingerprint: string };
interface GroupJob { id: string; subject: string; createdAt: string; role?: ModelRole; model: string; status: "running" | "paused" | "complete" | "error"; items: Item[]; completed: string[]; skipped: Array<{ id: string; reason: string }>; groups: RecallGroup[]; usage: { input: number; output: number; calls: number }; error?: string }
const file = () => path.join(PATHS.data, "recall-group-jobs.json");
function read(): GroupJob[] { try { const value: unknown = JSON.parse(fs.readFileSync(file(), "utf8")); if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { runs?: unknown }).runs)) throw new Error("Invalid group job data."); return (value as { runs: GroupJob[] }).runs; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }
function write(jobs: GroupJob[]) { fs.mkdirSync(PATHS.data, { recursive: true }); writeFileAtomicSync(file(), JSON.stringify({ version: 1, runs: jobs }), { allowInPlaceFallback: true }); }
function save(job: GroupJob) { const all = read(); write([...all.filter((entry) => entry.id !== job.id), job]); }
function active() { const g = globalThis as typeof globalThis & { __lhRecallGroupJobs?: Map<string, AbortController> }; return g.__lhRecallGroupJobs ??= new Map(); }
export function recallGroupJobs(subject: string) { return read().filter((job) => job.subject === subject).map((job) => ({ ...job, status: job.status === "running" && !active().has(job.id) ? "paused" as const : job.status })); }
export function recallGroupingActivity() {
 const running = active();
 if (!running.size) return [];
 return read().filter((job) => running.has(job.id)).map((job) => ({ subject: job.subject, done: job.completed.length + job.skipped.length, total: job.items.length }));
}
function engineFor(role?: ModelRole) { const resolved = role ? resolvePlannerEngine("coach", role) : null; if (role && resolved?.role !== role) throw new Error("The selected model is unavailable."); return { engine: recallGroupEngineOverride.current ?? resolved?.engine ?? analystEngine(), label: resolved?.modelLabel }; }
export function startRecallGroupJob(subject: string, expected: Item[], role?: ModelRole) {
 if (recallGroupJobs(subject).some((job) => active().has(job.id))) throw new Error("Grouping is already running for this subject.");
 const preview = recallGroupPreview(subject);
 if (!Array.isArray(expected) || expected.length !== preview.items.length || expected.some((item, index) => item.id !== preview.items[index]?.id || item.fingerprint !== preview.items[index]?.fingerprint)) throw new Error("The preview changed. Review it again before starting.");
 if (preview.items.length < 2) throw new Error("At least two assessed answers are needed.");
 if (role && !preview.availableRoles.some((entry) => entry.role === role)) throw new Error("The selected model is unavailable.");
 const resolved = engineFor(role);
 const job: GroupJob = { id: randomUUID(), subject, createdAt: new Date().toISOString(), role, model: resolved.label ?? preview.model, status: "paused", items: expected, completed: [], skipped: [], groups: [], usage: { input: 0, output: 0, calls: 0 } };
 save(job); launch(job, resolved.engine); return job;
}
export function resumeRecallGroupJob(id: string, role?: ModelRole, retrySkipped = false) {
 const job = read().find((entry) => entry.id === id); if (!job) throw new Error("Grouping run not found.");
 if (active().has(id) || recallGroupJobs(job.subject).some((entry) => active().has(entry.id))) throw new Error("Grouping is already running for this subject.");
 const chosen = role ?? job.role; const resolved = engineFor(chosen);
 if (role) { job.role = role; job.model = resolved.label ?? job.model; }
 if (retrySkipped) job.skipped = [];
 launch(job, resolved.engine); return job;
}
export function pauseRecallGroupJob(id: string) { active().get(id)?.abort(); return read().find((job) => job.id === id); }
function launch(job: GroupJob, engine: import("../agent/models.ts").PiEngine) {
 const controller = new AbortController();
 job.status = "running"; job.error = undefined;
 save(job);
 active().set(job.id, controller);
 void (async () => {
  try {
   const preview = recallGroupPreview(job.subject), current = new Map(preview.items.map((item) => [item.id, item]));
   const sources = recallGroupSourceSnapshot(job.subject);
   const done = new Set([...job.completed, ...job.skipped.map((item) => item.id)]);
   const pending = job.items.filter((entry) => !done.has(entry.id));
   const valid: RecallGroupItem[] = [];
   for (const entry of pending) { const item = current.get(entry.id); if (!item || item.fingerprint !== entry.fingerprint) job.skipped.push({ id: entry.id, reason: "The answer or assessment changed; review it before grouping." }); else valid.push(item); }
   save(job);
   const batches = batchRecallBySize(valid, (item) => JSON.stringify({ topic: item.topic, feedback: item.feedback, verdict: item.verdict, errorType: item.errorType, source: item.source }).length + 150, 20, 12000);
   const noContext = "No other topic is available for comparison yet.";
   const assess = async (part: RecallGroupItem[], depth: number, transientRetried = false): Promise<void> => {
    if (controller.signal.aborted || !part.length) return;
    if (part.length === 1 && job.groups.length === 0) { job.skipped.push({ id: part[0]!.id, reason: noContext }); save(job); return; }
    try {
     const result = await suggestRecallGroupBatch(job.subject, part, engine, job.role ?? "analyst", controller.signal, (usage, label) => { job.model = label; job.usage.input += usage.input || 0; job.usage.output += usage.output || 0; job.usage.calls++; save(job); }, job.groups);
     if (controller.signal.aborted) return;
     job.groups.push(...result.groups);
     job.completed.push(...part.map((item) => item.id)); save(job);
     // The job ledger is the durable checkpoint; the legacy draft is a secondary view.
     try { saveRecallGroupDraft(job.subject, job.groups, sources, undefined, result.model, job.id); } catch { /* keep durable job checkpoint if an earlier answer changed */ }
    } catch (error) {
     const kind = recallFailureKind(error);
     if (controller.signal.aborted || kind === "cancelled" || kind === "auth" || kind === "quota") throw error;
     if (kind === "transient" && !transientRetried) { await assess(part, depth, true); return; }
     if (kind === "split" && part.length > 1 && depth < 5) { const mid = Math.ceil(part.length / 2); await assess(part.slice(0, mid), depth + 1); await assess(part.slice(mid), depth + 1); return; }
     if (kind === "split") { for (const item of part) job.skipped.push({ id: item.id, reason: "Could not group this item; retry it later." }); save(job); return; }
     throw error;
    }
   };
   let consecutiveFailedBatches = 0;
   for (const batch of batches) {
    if (controller.signal.aborted) break;
    const beforeCompleted = job.completed.length;
    await assess(batch, 0);
    const onlyDeferredNoContext = batch.length === 1 && job.skipped.some((item) => item.id === batch[0]!.id && item.reason === noContext);
    if (job.completed.length === beforeCompleted && !onlyDeferredNoContext && !controller.signal.aborted) {
     consecutiveFailedBatches++;
     if (consecutiveFailedBatches >= 2) throw new Error("Stopped after repeated batch failures; check the selected model or retry later.");
    } else if (job.completed.length > beforeCompleted) {
     consecutiveFailedBatches = 0;
    }
   }
   // A split may leave an early singleton before any groups exist. Once later
   // batches have proposed topics, compare that deferred item automatically.
   if (!controller.signal.aborted && job.groups.length) {
    const deferred = new Set(job.skipped.filter((item) => item.reason === noContext).map((item) => item.id));
    if (deferred.size) {
     job.skipped = job.skipped.filter((item) => !deferred.has(item.id)); save(job);
     const deferredItems: RecallGroupItem[] = [];
     for (const id of deferred) {
      const entry = job.items.find((row) => row.id === id);
      const item = current.get(id);
      if (entry && item && item.fingerprint === entry.fingerprint) deferredItems.push(item);
      else job.skipped.push({ id, reason: "The answer or assessment changed; review it before grouping." });
     }
     for (const batch of batchRecallBySize(deferredItems, (item) => item.topic.length + item.feedback.length + 150, 20, 12000)) {
      if (controller.signal.aborted) break;
      await assess(batch, 0);
     }
    }
   }
   job.status = controller.signal.aborted ? "paused" : "complete";
  } catch (error) {
   job.status = controller.signal.aborted ? "paused" : "error";
   job.error = controller.signal.aborted ? undefined : `${mappingErrorMessage(error, controller.signal)} (Category: ${recallFailureKind(error)}.)`;
  }
  finally { active().delete(job.id); save(job); }
 })();
}

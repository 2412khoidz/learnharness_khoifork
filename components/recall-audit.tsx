"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecallScanResult } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";

type Item = { draft: RecallScanResult["draft"]; feedback?: string; sessionTitle: string; fingerprint: string; originalVerdict: string | null; originalSource: string; originalAssessment?: Pick<RecallScanResult, "strengths" | "missing" | "correction" | "evidence">; mistake: { status: string; analysis?: { errorType: string; topic: string; whatYouDid: string; correct: string; rule: string } } | null };
type Role = { role: string; label: string; modelLabel: string; pricing?: { input: number; output: number } | null };
type Preview = { items: Item[]; count: number; roles: Role[]; model: string; estimate: string; inputCharacters?: number };
type Result = { id: string; proposal: RecallScanResult; originalVerdict: string | null; originalSource: string; originalFeedback: string; originalAssessment?: Pick<RecallScanResult, "strengths" | "missing" | "correction" | "evidence">; originalMistake?: { status: string; analysis?: { whatYouDid: string; correct: string; rule: string } }; mistakeExists: boolean; model: string; applied?: boolean };
type Run = { id: string; createdAt: string; model: string; status: string; total: number; resultCount: number; results: Result[]; usage: { input: number; output: number; calls: number }; error?: string; skipped?: Array<{ id: string; reason: string }>; reviews: Array<{ id: string; at: string; undoneAt?: string; pending?: boolean }> };
const PAGE = 20;

export function RecallAudit({ onApplied }: { onApplied: () => Promise<void> }) {
 const [preview, setPreview] = useState<Preview | null>(null);
 const [previewOpen, setPreviewOpen] = useState(false);
 const [previewPage, setPreviewPage] = useState(0);
 const [openResults, setOpenResults] = useState<Record<string, boolean>>({});
 const [runs, setRuns] = useState<Run[]>([]);
 const [availableRoles, setAvailableRoles] = useState<Role[]>([]);
 const [activeId, setActiveId] = useState("");
 const [role, setRole] = useState("");
 const [selected, setSelected] = useState<Record<string, boolean>>({});
 const [remove, setRemove] = useState<Record<string, boolean>>({});
 const [page, setPage] = useState(0);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 const [notice, setNotice] = useState("");
 const progressSequence = useRef(0);
 const restoreGeneration = useRef(0);
 const [progressStatus, setProgressStatus] = useState("");
 const refresh = useCallback(async () => {
  const res = await fetch(`/api/planner/recall-audit?summary=1&runId=${encodeURIComponent(activeId)}&page=${page}`, { cache: "no-store" });
  const body = await res.json() as { runs?: Run[]; roles?: Role[]; error?: string };
  if (!res.ok) throw new Error(body.error || "Could not load audits.");
  setRuns(body.runs ?? []); setAvailableRoles(body.roles ?? []);
  setActiveId((id) => id || body.runs?.at(-1)?.id || "");
 }, [activeId, page]);
 useEffect(() => { void refresh().catch((err) => setError(err instanceof Error ? err.message : "Could not load audits.")); }, [refresh]);
 useEffect(() => {
  if (!activeId) return;
  type Saved = { selected: Record<string, boolean>; remove: Record<string, boolean>; page: number; sequence?: number };
  const generation = ++restoreGeneration.current, unchanged = progressSequence.current;
  let local: Saved | null = null;
  try { local = JSON.parse(localStorage.getItem(`lh:recall-audit-review:${activeId}`) ?? "null"); } catch { /* unreadable legacy progress */ }
  setSelected(local?.selected ?? {}); setRemove(local?.remove ?? {}); setPage(local?.page ?? 0);
  void fetch(`/api/planner/recall-progress?key=${encodeURIComponent(`audit:${activeId}`)}`, { cache: "no-store" }).then(async (response) => {
   if (!response.ok) throw new Error("Could not restore review progress.");
   const body = await response.json() as { progress?: { sequence: number; value: Saved } | null };
   if (restoreGeneration.current !== generation || progressSequence.current !== unchanged) return;
   if (body.progress && body.progress.sequence > (local?.sequence ?? 0)) { const saved = body.progress.value; setSelected(saved.selected ?? {}); setRemove(saved.remove ?? {}); setPage(saved.page ?? 0); }
  }).catch(() => setProgressStatus("Could not restore saved audit progress."));
  return () => { restoreGeneration.current++; };
 }, [activeId]);
 const saveProgress = (nextSelected: Record<string, boolean>, nextRemove: Record<string, boolean>, nextPage: number) => {
  const sequence = Math.max(progressSequence.current + 1, Date.now() * 1000); progressSequence.current = sequence;
  const value = { selected: nextSelected, remove: nextRemove, page: nextPage, sequence };
  try { localStorage.setItem(`lh:recall-audit-review:${activeId}`, JSON.stringify(value)); } catch { /* server copy remains authoritative */ }
  setProgressStatus("Saving review progress…");
  const payload = JSON.stringify({ key: `audit:${activeId}`, sequence, value });
  void fetch("/api/planner/recall-progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: payload.length < 60000 }).then((response) => { if (!response.ok) throw new Error("save failed"); if (progressSequence.current === sequence) setProgressStatus("Review progress saved on this device."); }).catch(() => { if (progressSequence.current === sequence) setProgressStatus("Could not save review progress; keep this window open and try again."); });
 };
 const active = runs.find((run) => run.id === activeId);
 useEffect(() => {
  if (active?.status !== "running") return;
  const timer = setInterval(() => { void refresh().catch(() => {}); }, 2500);
  return () => clearInterval(timer);
 }, [active?.status, refresh]);
 const loadPreview = async () => {
  setBusy(true); setError("");
  try { const res = await fetch("/api/planner/recall-audit?preview=1", { cache: "no-store" }); const body = await res.json() as Preview & { error?: string }; if (!res.ok) throw new Error(body.error || "Could not load preview."); setPreview(body); }
  catch (err) { setError(err instanceof Error ? err.message : "Could not load preview."); } finally { setBusy(false); }
 };
 const post = async (body: object) => {
  setBusy(true); setError(""); setNotice("");
  try { const res = await fetch("/api/planner/recall-audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const value = await res.json() as { id?: string; applied?: number; undone?: number; error?: string }; if (!res.ok) throw new Error(value.error || "Audit action failed."); if (value.id) setActiveId(value.id); if (value.applied !== undefined || value.undone !== undefined) { setSelected({}); setRemove({}); saveProgress({}, {}, page); setNotice(value.applied !== undefined ? `Applied ${value.applied} reviewed assessments.` : `Undid ${value.undone} assessments.`); await onApplied(); } await refresh(); }
  catch (err) { setError(err instanceof Error ? err.message : "Audit action failed."); } finally { setBusy(false); }
 };
 const previewPricing = preview?.roles.find((item) => item.role === (role || "analyst"))?.pricing;
 const estimateInput = preview ? Math.ceil((preview.inputCharacters ?? 0) / 3 + Math.ceil(preview.count / 8) * 500) : 0;
 const estimateOutput = preview ? preview.count * 200 : 0;
 const hypotheticalCost = previewPricing ? (estimateInput * previewPricing.input + estimateOutput * previewPricing.output) / 1000000 : null;
 const visible = active?.results ?? [];
 const chosen = Object.entries(selected).filter(([, checked]) => checked).map(([id]) => ({ id, ...(remove[id] ? { removeMistake: true } : {}) }));
 return <section aria-label="Recall assessment audit" className="space-y-3 rounded-xl border p-3">
  <h4 className="font-semibold">Review past assessments with AI</h4>
  <p>Check past answers independently. AI proposals do not change recall, Mistakes or FSRS until you review them. Auditing uses model tokens.</p>
  <button type="button" disabled={busy} onClick={() => void loadPreview()} className="rounded border px-2 py-1">Preview a new audit</button>
  {preview && <div className="space-y-2 rounded border p-2">
   <p>{preview.count} answers, including unassigned subjects. Batches adapt to the amount of text. Invalid or truncated batches may be split, with bounded extra calls. Completed answers are saved; difficult answers are set aside for later review.</p>
   <label>Model <select value={role} onChange={(event) => setRole(event.target.value)} className="rounded border bg-background p-1"><option value="">Analyst · {preview.model}</option>{preview.roles.map((item) => <option key={item.role} value={item.role}>{item.label} · {item.modelLabel}</option>)}</select></label>
   <p>{preview.estimate}</p>
   {hypotheticalCost !== null && previewPricing ? <p>Illustrative estimate: ${hypotheticalCost.toFixed(hypotheticalCost < 0.01 ? 4 : 2)} at catalog rates ${previewPricing.input}/1M input and ${previewPricing.output}/1M output tokens. Assumes roughly 3 characters per input token, 500 overhead tokens per batch and 200 output tokens per answer; actual tokenization, reasoning and retries can cost more. This is not a spending limit.</p> : <p>No reliable per-token price is available for this model or subscription. Actual billing depends on the provider.</p>}
   <details onToggle={(event) => setPreviewOpen(event.currentTarget.open)}><summary className="cursor-pointer">Show the answers and feedback to be sent</summary>{previewOpen && <><div className="max-h-80 overflow-auto">{preview.items.slice(previewPage * 10, (previewPage + 1) * 10).map((item) => <div key={item.draft.id} className="border-b py-2"><p>{item.draft.id} · {item.sessionTitle} · Previous: {item.originalVerdict ?? "not assessed"} ({item.originalSource})</p><ToolContentResponse>{item.draft.question}</ToolContentResponse><p>Your answer</p><ToolContentResponse>{item.draft.yourAnswer}</ToolContentResponse><p>Reference answer</p><ToolContentResponse>{item.draft.correctAnswer}</ToolContentResponse>{item.draft.thinking && <><p>Your recorded thinking</p><ToolContentResponse>{item.draft.thinking}</ToolContentResponse></>}{item.feedback && <><p>Previous tutor feedback</p><ToolContentResponse>{item.feedback}</ToolContentResponse></>}{item.originalAssessment && <><p>Previous AI assessment details (shown for comparison, not sent)</p><ToolContentResponse>{item.originalAssessment.strengths}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.missing}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.correction}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.evidence}</ToolContentResponse></>}{item.mistake?.analysis && <><p>Previous Mistakes analysis (the summary is sent) · {item.mistake.analysis.errorType} · {item.mistake.analysis.topic}</p><ToolContentResponse>{item.mistake.analysis.whatYouDid}</ToolContentResponse><ToolContentResponse>{item.mistake.analysis.correct}</ToolContentResponse><ToolContentResponse>{item.mistake.analysis.rule}</ToolContentResponse></>}</div>)}</div><div className="flex gap-3"><button type="button" disabled={previewPage === 0} onClick={() => setPreviewPage((p) => p - 1)}>Previous answers</button><span>{previewPage + 1} / {Math.max(1, Math.ceil(preview.items.length / 10))}</span><button type="button" disabled={(previewPage + 1) * 10 >= preview.items.length} onClick={() => setPreviewPage((p) => p + 1)}>Next answers</button></div></>}</details>
   <button type="button" disabled={busy || preview.count === 0 || active?.status === "running"} onClick={() => void post({ action: "start", ...(role ? { role } : {}), expected: preview.items.map((item) => ({ id: item.draft.id, fingerprint: item.fingerprint })) })} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Start audit with this model</button>
  </div>}
  {runs.length > 0 && <label>Audit run <select value={activeId} onChange={(event) => { setActiveId(event.target.value); }} className="rounded border bg-background p-1">{runs.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.model} · {run.resultCount}/{run.total}</option>)}</select></label>}
  {active && <div className="space-y-2">
   <p>Status: {active.status} · {active.resultCount}/{active.total} checked · {active.usage.calls} model calls · {active.usage.input} input / {active.usage.output} output tokens</p>
   {active.error && <p role="alert">{active.error}</p>}
   {!preview && active.status !== "running" && <label>Model for retry <select value={role} onChange={(event) => setRole(event.target.value)} className="rounded border bg-background p-1"><option value="">Keep {active.model}</option>{availableRoles.map((item) => <option key={item.role} value={item.role}>{item.label} · {item.modelLabel}</option>)}</select></label>}
   {(active.skipped?.length ?? 0) > 0 && <p role="status">{active.skipped?.length} answers could not be assessed; completed answers remain saved.</p>}
   {active.status === "running" ? <button type="button" disabled={busy} onClick={() => void post({ action: "pause", id: active.id })} className="rounded border px-2 py-1">Pause audit</button> : active.resultCount + (active.skipped?.length ?? 0) < active.total && <button type="button" disabled={busy} onClick={() => void post({ action: "resume", id: active.id, ...(role ? { role } : {}) })} className="rounded border px-2 py-1">Resume remaining answers</button>}
   {active.status !== "running" && (active.skipped?.length ?? 0) > 0 && <button type="button" disabled={busy} onClick={() => void post({ action: "resume", id: active.id, retrySkipped: true, ...(role ? { role } : {}) })} className="rounded border px-2 py-1">Retry skipped answers with selected model</button>}
   {active.reviews.filter((review) => !review.undoneAt).map((review) => <button key={review.id} type="button" disabled={busy || active.status === "running"} onClick={() => void post({ action: "undo", id: active.id, reviewId: review.id })} className="mr-2 rounded border px-2 py-1">{review.pending ? "Recover interrupted review" : "Undo review"} {new Date(review.at).toLocaleString()}</button>)}
   {active.reviews.some((review) => review.pending) && <p role="alert">A review was interrupted while saving. Use Recover interrupted review before applying another.</p>}
   {visible.map((item) => <details key={item.id} onToggle={(event) => { const open = event.currentTarget.open; setOpenResults((old) => old[item.id] === open ? old : { ...old, [item.id]: open }); }} className="rounded border p-2"><summary className="cursor-pointer">{item.proposal.sessionTitle} · {item.originalVerdict ?? "unassessed"} → {item.proposal.verdict} {item.applied ? "· applied" : "· proposal"}</summary>
    {openResults[item.id] && <><p>Question</p><ToolContentResponse>{item.proposal.draft.question}</ToolContentResponse><p>Your answer</p><ToolContentResponse>{item.proposal.draft.yourAnswer}</ToolContentResponse><p>Reference answer</p><ToolContentResponse>{item.proposal.draft.correctAnswer}</ToolContentResponse>
    <p>Previous assessment: {item.originalVerdict ?? "unassessed"} · {item.originalSource}</p>{item.originalFeedback && <ToolContentResponse>{item.originalFeedback}</ToolContentResponse>}
    {item.originalAssessment && <><p>Previous AI assessment details (shown for comparison, not sent)</p><ToolContentResponse>{item.originalAssessment.strengths}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.missing}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.correction}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.evidence}</ToolContentResponse></>}
    {item.originalMistake && <><p>Existing Mistakes entry: {item.originalMistake.status === "failed" ? "explanation failed; this is not a correctness verdict" : `analysis ${item.originalMistake.status}`}</p>{item.originalMistake.analysis && <><ToolContentResponse>{item.originalMistake.analysis.whatYouDid}</ToolContentResponse><ToolContentResponse>{item.originalMistake.analysis.correct}</ToolContentResponse><ToolContentResponse>{item.originalMistake.analysis.rule}</ToolContentResponse></>}</>}
    <p>New AI assessment: {item.proposal.verdict} · {item.model}</p><ToolContentResponse>{item.proposal.evidence}</ToolContentResponse><ToolContentResponse>{item.proposal.strengths}</ToolContentResponse><ToolContentResponse>{item.proposal.missing}</ToolContentResponse><ToolContentResponse>{item.proposal.correction}</ToolContentResponse>
    {!item.applied && <label className="block"><input type="checkbox" checked={Boolean(selected[item.id])} onChange={(event) => { const next = { ...selected, [item.id]: event.target.checked }; setSelected(next); saveProgress(next, remove, page); }} /> Approve this assessment</label>}
    {selected[item.id] && item.proposal.verdict === "correct" && item.mistakeExists && <label className="block"><input type="checkbox" checked={Boolean(remove[item.id])} onChange={(event) => { const next = { ...remove, [item.id]: event.target.checked }; setRemove(next); saveProgress(selected, next, page); }} /> Remove this from Mistakes (undo available)</label>}
    </>}
   </details>)}
   <div className="flex gap-3"><button type="button" disabled={page === 0} onClick={() => { setPage(page - 1); saveProgress(selected, remove, page - 1); }}>Previous</button><span>{page + 1} / {Math.max(1, Math.ceil(active.resultCount / PAGE))}</span><button type="button" disabled={(page + 1) * PAGE >= active.resultCount} onClick={() => { setPage(page + 1); saveProgress(selected, remove, page + 1); }}>Next</button></div>
   <button type="button" disabled={busy || active.status === "running" || !chosen.length || chosen.length > 100} onClick={() => void post({ action: "apply", id: active.id, choices: chosen })} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Apply reviewed assessments ({chosen.length})</button>
  </div>}
  {progressStatus && <p role="status">{progressStatus}</p>}
  {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
 </section>;
}

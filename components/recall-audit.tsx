"use client";
import { useCallback, useEffect, useState } from "react";
import type { RecallScanResult } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";

type Item = { draft: RecallScanResult["draft"]; feedback?: string; sessionTitle: string; fingerprint: string; originalVerdict: string | null; originalSource: string; originalAssessment?: Pick<RecallScanResult, "strengths" | "missing" | "correction" | "evidence">; mistake: { status: string; analysis?: { errorType: string; topic: string; whatYouDid: string; correct: string; rule: string } } | null };
type Role = { role: string; label: string; modelLabel: string };
type Preview = { items: Item[]; count: number; roles: Role[]; model: string; estimate: string };
type Result = { id: string; proposal: RecallScanResult; originalVerdict: string | null; originalSource: string; originalFeedback: string; originalAssessment?: Pick<RecallScanResult, "strengths" | "missing" | "correction" | "evidence">; originalMistake?: { status: string; analysis?: { whatYouDid: string; correct: string; rule: string } }; mistakeExists: boolean; model: string; applied?: boolean };
type Run = { id: string; createdAt: string; model: string; status: string; items: Array<{ id: string }>; results: Result[]; usage: { input: number; output: number; calls: number }; error?: string; reviews: Array<{ id: string; at: string; undoneAt?: string; pending?: boolean }> };
const PAGE = 20;

export function RecallAudit({ onApplied }: { onApplied: () => Promise<void> }) {
 const [preview, setPreview] = useState<Preview | null>(null);
 const [runs, setRuns] = useState<Run[]>([]);
 const [activeId, setActiveId] = useState("");
 const [role, setRole] = useState("");
 const [selected, setSelected] = useState<Record<string, boolean>>({});
 const [remove, setRemove] = useState<Record<string, boolean>>({});
 const [page, setPage] = useState(0);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 const [notice, setNotice] = useState("");
 const refresh = useCallback(async () => {
  const res = await fetch("/api/planner/recall-audit", { cache: "no-store" });
  const body = await res.json() as { runs?: Run[]; error?: string };
  if (!res.ok) throw new Error(body.error || "Could not load audits.");
  setRuns(body.runs ?? []);
  setActiveId((id) => id || body.runs?.at(-1)?.id || "");
 }, []);
 useEffect(() => { void refresh().catch((err) => setError(err instanceof Error ? err.message : "Could not load audits.")); }, [refresh]);
 useEffect(() => {
  if (!activeId) return;
  try { const saved = JSON.parse(localStorage.getItem(`lh:recall-audit-review:${activeId}`) ?? "null"); setSelected(saved?.selected ?? {}); setRemove(saved?.remove ?? {}); setPage(saved?.page ?? 0); } catch { setSelected({}); setRemove({}); setPage(0); }
 }, [activeId]);
 const saveProgress = (nextSelected: Record<string, boolean>, nextRemove: Record<string, boolean>, nextPage: number) => { try { localStorage.setItem(`lh:recall-audit-review:${activeId}`, JSON.stringify({ selected: nextSelected, remove: nextRemove, page: nextPage })); } catch { setError("Could not save review progress on this device."); } };
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
 const visible = active?.results.slice(page * PAGE, (page + 1) * PAGE) ?? [];
 const chosen = Object.entries(selected).filter(([, checked]) => checked).map(([id]) => ({ id, ...(remove[id] ? { removeMistake: true } : {}) }));
 return <section aria-label="Recall assessment audit" className="space-y-3 rounded-xl border p-3">
  <h4 className="font-semibold">Review past assessments with AI</h4>
  <p>Check past answers independently. AI proposals do not change recall, Mistakes or FSRS until you review them. Auditing uses model tokens.</p>
  <button type="button" disabled={busy} onClick={() => void loadPreview()} className="rounded border px-2 py-1">Preview a new audit</button>
  {preview && <div className="space-y-2 rounded border p-2">
   <p>{preview.count} answers, including unassigned subjects. Sent in batches of up to five. Completed batches are saved.</p>
   <label>Model <select value={role} onChange={(event) => setRole(event.target.value)} className="rounded border bg-background p-1"><option value="">Analyst · {preview.model}</option>{preview.roles.map((item) => <option key={item.role} value={item.role}>{item.label} · {item.modelLabel}</option>)}</select></label>
   <p>{preview.estimate}</p>
   <details><summary className="cursor-pointer">Show the answers and feedback to be sent</summary><div className="max-h-80 overflow-auto">{preview.items.map((item) => <div key={item.draft.id} className="border-b py-2"><p>{item.draft.id} · {item.sessionTitle} · Previous: {item.originalVerdict ?? "not assessed"} ({item.originalSource})</p><ToolContentResponse>{item.draft.question}</ToolContentResponse><p>Your answer</p><ToolContentResponse>{item.draft.yourAnswer}</ToolContentResponse><p>Reference answer</p><ToolContentResponse>{item.draft.correctAnswer}</ToolContentResponse>{item.draft.thinking && <><p>Your recorded thinking</p><ToolContentResponse>{item.draft.thinking}</ToolContentResponse></>}{item.feedback && <><p>Previous tutor feedback</p><ToolContentResponse>{item.feedback}</ToolContentResponse></>}{item.originalAssessment && <><p>Previous AI assessment details</p><ToolContentResponse>{item.originalAssessment.strengths}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.missing}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.correction}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.evidence}</ToolContentResponse></>}{item.mistake?.analysis && <><p>Previous Mistakes analysis · {item.mistake.analysis.errorType} · {item.mistake.analysis.topic}</p><ToolContentResponse>{item.mistake.analysis.whatYouDid}</ToolContentResponse><ToolContentResponse>{item.mistake.analysis.correct}</ToolContentResponse><ToolContentResponse>{item.mistake.analysis.rule}</ToolContentResponse></>}</div>)}</div></details>
   <button type="button" disabled={busy || preview.count === 0 || active?.status === "running"} onClick={() => void post({ action: "start", ...(role ? { role } : {}), expected: preview.items.map((item) => ({ id: item.draft.id, fingerprint: item.fingerprint })) })} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Start audit with this model</button>
  </div>}
  {runs.length > 0 && <label>Audit run <select value={activeId} onChange={(event) => { setActiveId(event.target.value); }} className="rounded border bg-background p-1">{runs.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.model} · {run.results.length}/{run.items.length}</option>)}</select></label>}
  {active && <div className="space-y-2">
   <p>Status: {active.status} · {active.results.length}/{active.items.length} checked · {active.usage.calls} model calls · {active.usage.input} input / {active.usage.output} output tokens</p>
   {active.error && <p role="alert">{active.error}</p>}
   {active.status === "running" ? <button type="button" disabled={busy} onClick={() => void post({ action: "pause", id: active.id })} className="rounded border px-2 py-1">Pause audit</button> : active.results.length < active.items.length && <button type="button" disabled={busy} onClick={() => void post({ action: "resume", id: active.id, ...(role ? { role } : {}) })} className="rounded border px-2 py-1">Resume remaining answers</button>}
   {active.reviews.filter((review) => !review.undoneAt).map((review) => <button key={review.id} type="button" disabled={busy || active.status === "running"} onClick={() => void post({ action: "undo", id: active.id, reviewId: review.id })} className="mr-2 rounded border px-2 py-1">{review.pending ? "Recover interrupted review" : "Undo review"} {new Date(review.at).toLocaleString()}</button>)}
   {active.reviews.some((review) => review.pending) && <p role="alert">A review was interrupted while saving. Use Recover interrupted review before applying another.</p>}
   {visible.map((item) => <details key={item.id} className="rounded border p-2"><summary className="cursor-pointer">{item.proposal.sessionTitle} · {item.originalVerdict ?? "unassessed"} → {item.proposal.verdict} {item.applied ? "· applied" : "· proposal"}</summary>
    <p>Question</p><ToolContentResponse>{item.proposal.draft.question}</ToolContentResponse><p>Your answer</p><ToolContentResponse>{item.proposal.draft.yourAnswer}</ToolContentResponse><p>Reference answer</p><ToolContentResponse>{item.proposal.draft.correctAnswer}</ToolContentResponse>
    <p>Previous assessment: {item.originalVerdict ?? "unassessed"} · {item.originalSource}</p>{item.originalFeedback && <ToolContentResponse>{item.originalFeedback}</ToolContentResponse>}
    {item.originalAssessment && <><p>Previous AI assessment details</p><ToolContentResponse>{item.originalAssessment.strengths}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.missing}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.correction}</ToolContentResponse><ToolContentResponse>{item.originalAssessment.evidence}</ToolContentResponse></>}
    {item.originalMistake && <><p>Existing Mistakes entry: {item.originalMistake.status}</p>{item.originalMistake.analysis && <><ToolContentResponse>{item.originalMistake.analysis.whatYouDid}</ToolContentResponse><ToolContentResponse>{item.originalMistake.analysis.correct}</ToolContentResponse><ToolContentResponse>{item.originalMistake.analysis.rule}</ToolContentResponse></>}</>}
    <p>New AI assessment: {item.proposal.verdict} · {item.model}</p><ToolContentResponse>{item.proposal.evidence}</ToolContentResponse><ToolContentResponse>{item.proposal.strengths}</ToolContentResponse><ToolContentResponse>{item.proposal.missing}</ToolContentResponse><ToolContentResponse>{item.proposal.correction}</ToolContentResponse>
    {!item.applied && <label className="block"><input type="checkbox" checked={Boolean(selected[item.id])} onChange={(event) => { const next = { ...selected, [item.id]: event.target.checked }; setSelected(next); saveProgress(next, remove, page); }} /> Approve this assessment</label>}
    {selected[item.id] && item.proposal.verdict === "correct" && item.mistakeExists && <label className="block"><input type="checkbox" checked={Boolean(remove[item.id])} onChange={(event) => { const next = { ...remove, [item.id]: event.target.checked }; setRemove(next); saveProgress(selected, next, page); }} /> Remove this from Mistakes (undo available)</label>}
   </details>)}
   <div className="flex gap-3"><button type="button" disabled={page === 0} onClick={() => { setPage(page - 1); saveProgress(selected, remove, page - 1); }}>Previous</button><span>{page + 1} / {Math.max(1, Math.ceil(active.results.length / PAGE))}</span><button type="button" disabled={(page + 1) * PAGE >= active.results.length} onClick={() => { setPage(page + 1); saveProgress(selected, remove, page + 1); }}>Next</button></div>
   <button type="button" disabled={busy || active.status === "running" || !chosen.length || chosen.length > 100} onClick={() => void post({ action: "apply", id: active.id, choices: chosen })} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Apply reviewed assessments ({chosen.length})</button>
  </div>}
  {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
 </section>;
}

"use client";

import { useState } from "react";
import type { LearningCapacityReport } from "@/src/core";
import { recallAnswerHref } from "@/src/core";
import type { RecallGroup } from "@/src/core";

type Row = LearningCapacityReport["subjectBreakdown"][number];
type PreviewItem = { id: string; fingerprint: string; topic: string; errorType: string; verdict?: string; source?: string; feedback: string; needsReview?: boolean; chatId: string; sourceMessageId?: string; toolCallId?: string };
type Preview = { subject: string; totalAnswers: number; totalEligible: number; limit: number; offset: number; model: string; availableRoles: Array<{ role: string; label: string; modelLabel: string }>; items: PreviewItem[]; allItems: PreviewItem[]; groups: RecallGroup[]; draft: RecallGroup[] | null; approvedRevision: string };

export function RecallAnalysis({ report, onRefresh }: { report: LearningCapacityReport; onRefresh: () => Promise<void> }) {
	const [subject, setSubject] = useState("");
	const [range, setRange] = useState<"last30" | "allTime">("last30");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [groups, setGroups] = useState<RecallGroup[]>([]);
	const [approved, setApproved] = useState<Record<string, boolean>>({});
	const [splitSelection, setSplitSelection] = useState<Record<string, boolean>>({});
	const [role, setRole] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const subjects = report.subjectBreakdown.filter((item) => item.recallInsights?.allTime.responses > 0);
	const row: Row | undefined = subjects.find((item) => item.subject === subject) ?? subjects[0];
	const activeSubject = row?.subject ?? "";
	const window = row?.recallInsights[range];
	const selectedModel = preview?.availableRoles.find((item) => item.role === role)?.modelLabel ?? preview?.model;
	const loadPreview = async (offset = 0) => {
		setBusy(true); setError(""); setNotice("");
		try {
			const res = await fetch(`/api/planner/recall-groups?subject=${encodeURIComponent(activeSubject)}&offset=${offset}`, { cache: "no-store" });
			const value = await res.json() as Preview & { error?: string };
			if (!res.ok) throw new Error(value.error || "Could not load the preview.");
			const editable = value.draft ? [...value.groups.filter((group) => !value.draft!.some((draft) => draft.id === group.id)), ...value.draft] : value.groups;
			setPreview(value); setGroups(editable); setApproved(Object.fromEntries(value.groups.map((group) => [group.id, true]))); setSplitSelection({});
			if (value.draft) setNotice("Restored local unapproved suggestions. The existing approved groups remain in the report until you save a new selection.");
		} catch (err) { setError(err instanceof Error ? err.message : "Could not load the preview."); }
		finally { setBusy(false); }
	};
	const suggest = async () => {
		if (!preview) return;
		setBusy(true); setError(""); setNotice("");
		try {
			const res = await fetch("/api/planner/recall-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "suggest", subject: activeSubject, offset: preview.offset, expected: preview.items.map(({ id, fingerprint }) => ({ id, fingerprint })), ...(role ? { preferredRole: role } : {}) }) });
			const value = await res.json() as { groups?: RecallGroup[]; model?: string; error?: string };
			if (!res.ok || !value.groups) throw new Error(value.error || "Could not suggest groups.");
			setGroups([...preview.groups, ...value.groups]); setApproved(Object.fromEntries(preview.groups.map((group) => [group.id, true]))); setSplitSelection({});
			setNotice(value.groups.length ? `Suggestions from ${value.model ?? "the selected model"} are not yet approved. Review and select each group.` : "The model found no supported groups. Existing approved groups remain unchanged.");
		} catch (err) { setError(err instanceof Error ? err.message : "Could not suggest groups."); }
		finally { setBusy(false); }
	};
	const save = async () => {
		if (!preview) return;
		setBusy(true); setError(""); setNotice("");
		try {
			const selected = groups.filter((group) => approved[group.id]);
			const res = await fetch("/api/planner/recall-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", subject: activeSubject, groups: selected, approvedRevision: preview.approvedRevision }) });
			const value = await res.json() as { saved?: number; error?: string };
			if (!res.ok) throw new Error(value.error || "Could not approve groups.");
			setNotice(`Saved ${value.saved ?? 0} approved groups for this subject.`); setPreview(null); await onRefresh();
		} catch (err) { setError(err instanceof Error ? err.message : "Could not approve groups."); }
		finally { setBusy(false); }
	};
	const saveDraft = async () => {
		setBusy(true); setError("");
		try {
			const res = await fetch("/api/planner/recall-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_draft", subject: activeSubject, groups }) });
			const value = await res.json() as { error?: string };
			if (!res.ok) throw new Error(value.error || "Could not save draft.");
			setNotice("Draft saved locally. It is not included in the report or sent to Coach.");
		} catch (err) { setError(err instanceof Error ? err.message : "Could not save draft."); }
		finally { setBusy(false); }
	};
	const split = (group: RecallGroup) => {
		const chosen = group.members.filter((member) => splitSelection[member.id]);
		const rest = group.members.filter((member) => !splitSelection[member.id]);
		if (chosen.length < 2 || rest.length < 2) { setError("Choose at least two answers for each resulting group."); return; }
		const id = crypto.randomUUID();
		setGroups((old) => [...old.map((item) => item.id === group.id ? { ...item, members: rest } : item), { ...group, id, name: `${group.name} (split)`, members: chosen }]);
		setApproved((old) => ({ ...old, [group.id]: false, [id]: false })); setSplitSelection({}); setError("");
	};
	return <section aria-label="Recall Analysis" className="space-y-3 rounded-xl border bg-background/70 p-4">
		<h3 className="text-sm font-semibold">Recall Analysis</h3>
		<p className="text-muted-foreground">Independent evidence from free recall. AI assessments are provisional and can be corrected. Composite, Practice and FSRS remain separate.</p>
		<p className="text-muted-foreground">Coverage: {report.dataCoverage.recallAssigned ?? 0} of {report.dataCoverage.recallAnswers ?? 0} eligible recall/explain answers have an identifiable subject; {report.dataCoverage.recallUnassigned ?? 0} are unassigned. The workspace telemetry counter may also include coding questions and uses a different counting method.</p>
		{(report.dataCoverage.recallUnassignedExamples?.length ?? 0) > 0 && <details><summary className="cursor-pointer">View unassigned answers</summary>{report.dataCoverage.recallUnassignedExamples?.map((item, index) => <a key={`${item.chatId}:${item.toolCallId ?? index}`} className="mr-2 underline" href={recallAnswerHref(item.chatId, item.sourceMessageId, item.toolCallId)}>Answer {index + 1}</a>)}</details>}
		{!row || !window ? <p>No subject-linked recall answers yet.</p> : <>
			<div className="flex flex-wrap items-center gap-2"><label>Subject <select aria-label="Recall subject" value={activeSubject} onChange={(event) => { setSubject(event.target.value); setPreview(null); setError(""); setNotice(""); }} className="rounded border bg-background p-1">{subjects.map((item) => <option key={item.subject} value={item.subject}>{item.subject}</option>)}</select></label><span>Period:</span><button type="button" aria-pressed={range === "last30"} onClick={() => setRange("last30")} className="rounded border px-2 py-1 aria-pressed:bg-accent">Last 30 days</button><button type="button" aria-pressed={range === "allTime"} onClick={() => setRange("allTime")} className="rounded border px-2 py-1 aria-pressed:bg-accent">All time</button></div>
			<div className="rounded border p-3 space-y-1"><p><strong>{window.responses}</strong> answers · <strong>{window.assessed}</strong> assessed · {window.days} days · {window.responses - window.assessed} not assessed{window.needsReview ? ` (${window.needsReview} changed; needs review)` : ""}</p><p>{window.correct} correct · {window.partial} partial · {window.wrong} incorrect · {window.dontKnow} did not know · {window.uncertain} uncertain</p><p>{window.ai} provisional AI · {window.confirmed} learner-confirmed or corrected</p><p>Help: {window.independent} independent · {window.assisted} assisted · {window.helpUnknown} unknown</p><p>Recorded timer: {window.medianTimerMin === null ? "not enough data" : `median ${window.medianTimerMin} min (${window.timerCount} answers)`}. Elapsed question-to-answer: {window.medianElapsedMin === null ? "not enough data" : `median ${window.medianElapsedMin} min (${window.elapsedCount} answers; includes breaks)`}.</p>{range === "last30" && <p>{row.recallInsights.trend ? `Compared with the prior 30 days: correct ${row.recallInsights.trend.correctRateDelta >= 0 ? "+" : ""}${row.recallInsights.trend.correctRateDelta} pp, partial ${row.recallInsights.trend.partialRateDelta >= 0 ? "+" : ""}${row.recallInsights.trend.partialRateDelta} pp. Question difficulty may differ.` : "Not enough assessed answers across both periods to compare trends."}</p>}{window.staleExamples.map((item, index) => <a key={`${item.chatId}:${index}`} className="mr-2 underline" href={recallAnswerHref(item.chatId, item.sourceMessageId, item.toolCallId)}>Review changed answer {index + 1}</a>)}</div>
			<h4 className="font-medium">Approved topic groups</h4>
			{(row.approvedRecallGroups?.[range] ?? []).length === 0 ? <p className="text-muted-foreground">No approved groups yet. Existing assessments remain available above.</p> : (row.approvedRecallGroups?.[range] ?? []).map((group) => <details key={group.id} className="rounded border p-2"><summary className="cursor-pointer">{group.name} · {group.count} answers {group.stale && "· source changed: review required"}</summary><p>{group.reason}</p><p>{group.distribution.correct} correct · {group.distribution.partial} partial · {group.distribution.wrong} incorrect · {group.distribution.dont_know} did not know · {group.distribution.uncertain} uncertain</p><p className="text-muted-foreground">{group.stale ? "This group is excluded from AI planning until reviewed again." : `Approved; suggested by ${group.model}.`}</p>{group.answers.map((answer, index) => <a key={answer.id} className="mr-2 underline" href={recallAnswerHref(answer.chatId, answer.sourceMessageId, answer.toolCallId)}>Answer {index + 1}</a>)}</details>)}
			{!preview && <button type="button" disabled={busy} onClick={() => void loadPreview()} className="rounded border px-3 py-1.5">Review AI grouping input</button>}
			{preview && <div className="space-y-3 rounded border p-3"><h4 className="font-medium">Preview before sending to AI</h4><p>Subject: {preview.subject} · {preview.items.length} items will be sent ({preview.totalEligible} eligible, {preview.totalAnswers} subject-linked answers). No re-scan is performed.</p>{preview.totalEligible > preview.limit && <div className="flex flex-wrap items-center gap-2"><span>Batch {Math.floor(preview.offset / preview.limit) + 1} / {Math.ceil(preview.totalEligible / preview.limit)}</span><button type="button" disabled={busy || preview.offset === 0} onClick={() => void loadPreview(Math.max(0, preview.offset - preview.limit))} className="rounded border px-2 py-1 disabled:opacity-40">Previous batch</button><button type="button" disabled={busy || preview.offset + preview.limit >= preview.totalEligible} onClick={() => void loadPreview(preview.offset + preview.limit)} className="rounded border px-2 py-1 disabled:opacity-40">Next batch</button><span>Save your edits before switching batches. A new request replaces the local draft; approved groups are preserved.</span></div>}<label>Model for this request <select value={role} onChange={(event) => setRole(event.target.value)} className="rounded border bg-background p-1"><option value="">Analyst (default)</option>{preview.availableRoles.map((item) => <option key={item.role} value={item.role}>{item.label} · {item.modelLabel}</option>)}</select></label><p>Selected model: {selectedModel}</p><details><summary className="cursor-pointer">Show all {preview.items.length} assessment items to be sent</summary><div className="max-h-64 overflow-auto">{preview.items.map((item) => <div key={item.id} className="border-b py-1"><p>{item.id} · {item.topic || "No topic"} · {item.errorType || "No error type"} · {item.verdict} · {item.source === "user" ? "learner correction" : "provisional AI"}</p>{item.feedback && <p>{item.feedback}</p>}</div>)}</div></details><div className="flex flex-wrap gap-2"><button type="button" disabled={busy || preview.items.length < 2} onClick={() => void suggest()} className="rounded border px-3 py-1.5 disabled:opacity-40">Send preview and suggest groups</button><button type="button" onClick={() => setPreview(null)} className="rounded border px-3 py-1.5">Close</button></div>
				{groups.length > 0 && <><p>Review, rename, remove answers or split groups. Saving approved groups replaces this subject’s approved groups with only those checked below; it never changes FSRS or the plan.</p>{groups.map((group) => <div key={group.id} className="space-y-2 rounded border p-2"><label><input type="checkbox" checked={Boolean(approved[group.id])} onChange={(event) => setApproved((old) => ({ ...old, [group.id]: event.target.checked }))} /> Approve this group</label><label className="block">Name <input value={group.name} onChange={(event) => setGroups((old) => old.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item))} className="w-full rounded border bg-background p-1" /></label><label className="block">Reason <textarea value={group.reason} onChange={(event) => setGroups((old) => old.map((item) => item.id === group.id ? { ...item, reason: event.target.value } : item))} className="w-full rounded border bg-background p-1" /></label><p>{group.members.length} answers · {group.model}</p>{group.members.map((member) => { const item = preview.allItems.find((value) => value.id === member.id); const changed = !item || item.fingerprint !== member.fingerprint; return <div key={member.id} className="flex flex-wrap items-center gap-2"><label><input type="checkbox" checked={Boolean(splitSelection[member.id])} onChange={(event) => setSplitSelection((old) => ({ ...old, [member.id]: event.target.checked }))} /> {item?.topic || member.id} · {item?.verdict ?? "unavailable"}{changed && " · changed"}</label>{item && <a className="underline" href={recallAnswerHref(item.chatId, item.sourceMessageId, item.toolCallId)}>Open answer</a>}<button type="button" onClick={() => { setGroups((old) => old.map((value) => value.id === group.id ? { ...value, members: value.members.filter((m) => m.id !== member.id) } : value)); setApproved((old) => ({ ...old, [group.id]: false })); }} className="underline">Remove</button>{changed && item && item.verdict && !item.needsReview && <button type="button" onClick={() => { setGroups((old) => old.map((value) => value.id === group.id ? { ...value, members: value.members.map((m) => m.id === member.id ? { ...m, fingerprint: item.fingerprint } : m) } : value)); setApproved((old) => ({ ...old, [group.id]: false })); }} className="underline">Use current assessment</button>}</div>; })}<button type="button" onClick={() => split(group)} className="rounded border px-2 py-1">Split selected answers</button></div>)}<div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void saveDraft()} className="rounded border px-3 py-1.5 disabled:opacity-40">Save draft</button><button type="button" disabled={busy || !groups.some((group) => approved[group.id])} onClick={() => void save()} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Save approved groups</button></div></>}
			</div>}
		</>}
		{error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
	</section>;
}

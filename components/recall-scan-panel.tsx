"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MistakeRecord, RecallScanState } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";

const labels: Record<string, string> = { correct: "Correct", partial: "Partly correct", wrong: "Incorrect", dont_know: "Did not know", uncertain: "Needs review" };
const PAGE_SIZE = 20;

/** Historical grading is separate from saving: the learner reviews every proposed entry. */
export function RecallScanPanel({ records, onSaved }: { records: MistakeRecord[]; onSaved: () => void }) {
	const [scan, setScan] = useState<RecallScanState | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [filter, setFilter] = useState("all");
	const [page, setPage] = useState(0);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		const res = await fetch("/api/mistakes/recall-scan", { cache: "no-store" });
		if (!res.ok) throw new Error("Could not load recall scan.");
		setScan(await res.json() as RecallScanState);
	}, []);
	useEffect(() => { void refresh().catch(() => setError("Could not load recall scan.")); }, [refresh]);
	useEffect(() => {
		if (scan?.status !== "running") return;
		const timer = setInterval(() => void refresh().catch(() => setError("Could not refresh recall scan.")), 3000);
		return () => clearInterval(timer);
	}, [scan?.status, refresh]);
	const action = async (type: "start" | "pause" | "save") => {
		setBusy(true); setError(null); setMessage(null);
		try {
			const res = await fetch("/api/mistakes/recall-scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: type, ...(type === "save" ? { ids: [...selected] } : {}) }) });
			const body = await res.json() as { error?: string; added?: number };
			if (!res.ok) throw new Error(body.error || "Recall scan request failed.");
			if (type === "save") { setSelected(new Set()); setMessage(`Saved ${body.added ?? 0} selected entries.`); onSaved(); }
			await refresh();
		} catch (e) { setError(e instanceof Error ? e.message : "Recall scan request failed."); }
		finally { setBusy(false); }
	};
	const known = useMemo(() => new Set(records.map((r) => r.id)), [records]);
	const filtered = useMemo(() => (scan?.results ?? []).filter((r) => filter === "all" || r.verdict === filter), [scan, filter]);
	const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
	const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	return (
		<section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Free-recall review">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div><h2 className="font-medium">Review past free-recall answers</h2><p className="mt-1 text-xs text-muted-foreground">AI reviews saved answers and tutor feedback in batches. Review the results and select entries before saving them to Mistakes.</p></div>
				{scan?.status === "running" ? <button disabled={busy} onClick={() => void action("pause")} className="rounded-md border px-3 py-1.5 text-xs">Pause</button> : <button disabled={busy || !scan} onClick={() => void action("start")} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground">{scan && scan.results.length > 0 ? "Resume scan" : "Scan free recall with AI"}</button>}
			</div>
			<p className="text-xs text-muted-foreground" role="status">{scan ? `${scan.status}: ${scan.results.length} / ${scan.total} answers assessed` : "Loading scan…"}. The configured analyst model receives the relevant saved answers; scanning can take time and use model quota.</p>
			{scan?.usage && <p className="text-xs text-muted-foreground">Reported usage: {scan.usage.input.toLocaleString()} input · {scan.usage.output.toLocaleString()} output · {scan.usage.cacheRead.toLocaleString()} cache-read · {scan.usage.cacheWrite.toLocaleString()} cache-write tokens ({scan.usage.modelCalls} model responses). Provider billing may differ.</p>}
			{(error || scan?.error) && <p role="alert" className="text-xs text-destructive">{error || scan?.error}</p>}
			{message && <p role="status" className="text-xs">{message}</p>}
			{scan && scan.results.length > 0 && <>
				<div className="flex flex-wrap items-center gap-2">
					<select aria-label="Filter recall assessments" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} className="rounded-md border bg-background px-2 py-1 text-xs"><option value="all">All assessments</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
					<button disabled={busy || selected.size === 0} onClick={() => void action("save")} className="rounded-md border px-3 py-1 text-xs disabled:opacity-50">Save selected ({selected.size})</button>
				</div>
				<div className="space-y-2">{visible.map((result) => {
					const eligible = result.verdict === "partial" || result.verdict === "wrong" || result.verdict === "dont_know";
					return <details key={result.id} className="rounded-lg border bg-background p-2.5 text-xs">
						<summary className="cursor-pointer"><strong>{labels[result.verdict]}</strong> · {result.sessionTitle} · {result.draft.question}</summary>
						<div className="mt-2 space-y-2">
							<div><strong>Your answer:</strong><ToolContentResponse>{result.draft.yourAnswer}</ToolContentResponse></div>
							{result.strengths && <div><strong>What was right:</strong><ToolContentResponse>{result.strengths}</ToolContentResponse></div>}
							{result.missing && <div><strong>What was missing:</strong><ToolContentResponse>{result.missing}</ToolContentResponse></div>}
							{result.correction && <div><strong>Correction:</strong><ToolContentResponse>{result.correction}</ToolContentResponse></div>}
							<div><strong>Evidence:</strong><ToolContentResponse>{result.evidence}</ToolContentResponse></div>
							{known.has(result.id) ? <p>Already saved to Mistakes.</p> : eligible ? <label className="inline-flex items-center gap-2"><input type="checkbox" checked={selected.has(result.id)} onChange={(e) => setSelected((prev) => { const next = new Set(prev); if (e.target.checked) next.add(result.id); else next.delete(result.id); return next; })} /> Save this assessment</label> : <p className="text-muted-foreground">This assessment is not a confirmed mistake.</p>}
						</div>
					</details>;
				})}</div>
				<div className="flex items-center gap-3 text-xs"><button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-40">Previous</button><span>{Math.min(page + 1, pages)} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-40">Next</button></div>
			</>}
		</section>
	);
}

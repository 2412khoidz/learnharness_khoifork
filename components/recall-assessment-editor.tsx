"use client";

import { useState } from "react";
import type { RecallVerdict, RecallHelp } from "@/src/core";

type Entry = { verdict?: RecallVerdict; help?: RecallHelp; timerMs?: number; updatedAt: string };
type Loaded = { fingerprint: string; entry: Entry | null; fsrsReview: { rating: number; nodeId: string } | null };

/** A local correction affects recall evidence only; it never changes an FSRS review. */
export function RecallAssessmentEditor({ id, verdict }: { id: string; verdict: RecallVerdict }) {
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [selected, setSelected] = useState<RecallVerdict>(verdict);
	const [help, setHelp] = useState<RecallHelp>("unknown");
	const [minutes, setMinutes] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const load = async () => {
		setBusy(true); setStatus("");
		try {
			const response = await fetch(`/api/planner/recall-evidence?id=${encodeURIComponent(id)}`, { cache: "no-store" });
			const body = await response.json() as Loaded & { error?: string };
			if (!response.ok) throw new Error(body.error || "Could not load this answer.");
			setLoaded(body); setSelected(body.entry?.verdict ?? verdict); setHelp(body.entry?.help ?? "unknown"); setMinutes(body.entry?.timerMs === undefined ? "" : String(body.entry.timerMs / 60000));
		} catch (error) { setStatus(error instanceof Error ? error.message : "Could not load this answer."); }
		finally { setBusy(false); }
	};
	const save = async () => {
		if (!loaded) return;
		const value = minutes.trim() === "" ? undefined : Number(minutes);
		if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 10080)) { setStatus("Enter a valid time in minutes."); return; }
		setBusy(true); setStatus("");
		try {
			const response = await fetch("/api/planner/recall-evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, fingerprint: loaded.fingerprint, expectedUpdatedAt: loaded.entry?.updatedAt ?? null, verdict: selected, help, ...(value !== undefined ? { timerMs: Math.round(value * 60000) } : {}) }) });
			const body = await response.json() as { entry?: Entry; error?: string };
			if (!response.ok || !body.entry) throw new Error(body.error || "Could not save correction.");
			setLoaded({ ...loaded, entry: body.entry }); setStatus("Saved for Learning Capacity. Existing FSRS reviews are unchanged.");
		} catch (error) { setStatus(error instanceof Error ? error.message : "Could not save correction."); }
		finally { setBusy(false); }
	};
	return <div className="rounded border p-2">
		{!loaded ? <button type="button" disabled={busy} onClick={() => void load()} className="rounded border px-2 py-1">Review or correct recall evidence</button> : <div className="space-y-2">
			<p>Original AI assessment remains visible above. This correction is used for recall evidence, not automatically for FSRS.</p>
			{loaded.fsrsReview && <p role="note">This answer already has a confirmed FSRS rating of {loaded.fsrsReview.rating}. If you change your assessment, check whether that earlier rating still fits; it will not be changed automatically.</p>}
			<label className="mr-2">Assessment <select value={selected} onChange={(event) => setSelected(event.target.value as RecallVerdict)} className="rounded border bg-background p-1"><option value="correct">Correct</option><option value="partial">Partly correct</option><option value="wrong">Incorrect</option><option value="dont_know">Did not know</option><option value="uncertain">Uncertain</option></select></label>
			<label className="mr-2">Help <select value={help} onChange={(event) => setHelp(event.target.value as RecallHelp)} className="rounded border bg-background p-1"><option value="unknown">Unknown</option><option value="independent">Independent</option><option value="assisted">Assisted</option></select></label>
			<label>Time in minutes (optional) <input type="number" min="0" max="10080" step="0.1" value={minutes} onChange={(event) => setMinutes(event.target.value)} className="w-20 rounded border bg-background p-1" /></label>
			<div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void save()} className="rounded border px-2 py-1">Save correction</button><button type="button" onClick={() => setLoaded(null)} className="rounded border px-2 py-1">Close</button></div>
		</div>}
		{status && <p role="status" className="mt-1">{status}</p>}
	</div>;
}

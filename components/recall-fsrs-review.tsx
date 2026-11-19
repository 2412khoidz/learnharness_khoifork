"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeConceptSearch, presentMistakeAnalysis, type RecallScanResult } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { PageControls } from "@/components/page-controls";
import { RecallAssessmentEditor } from "@/components/recall-assessment-editor";

type Node = { id: string; name: string; statement: string; reviewedFlashcard: boolean; revision: string };
type Suggestion = { answerId: string; nodeId: string; reason: string; model: string };
type Result = RecallScanResult & { suggestedNodeIds: string[]; applied: boolean; revision: string; effectiveVerdict?: RecallScanResult["verdict"]; assessmentSource?: string; aiSuggestion?: Suggestion | null; aiSuggestionIssue?: string };
type Selection = { nodeId: string; rating: number };
const verdictLabels: Record<RecallScanResult["verdict"], string> = { correct: "Correct", partial: "Partly correct", wrong: "Incorrect", dont_know: "Did not know", uncertain: "Needs review" };
const defaultRating = (verdict: Result["verdict"]) => verdict === "correct" ? 3 : verdict === "partial" ? 2 : verdict === "uncertain" ? 0 : 1;
const PAGE_SIZE = 20;

function MappingCard({ item, nodes, selection, onSelect, onRemove, refresh, preferredRole, modelLabel }: { item: Result; nodes: Node[]; selection?: Selection; onSelect: (part: Partial<Selection>) => void; onRemove: () => void; refresh: () => Promise<void>; preferredRole: string; modelLabel: string }) {
	const [query, setQuery] = useState("");
	const [question, setQuestion] = useState("");
	const [history, setHistory] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const chosen = nodes.find((node) => node.id === selection?.nodeId);
	const suggested = nodes.find((node) => node.id === item.aiSuggestion?.nodeId);
	const filtered = query.trim() ? nodes.filter((node) => normalizeConceptSearch(`${node.name} ${node.statement}`).includes(normalizeConceptSearch(query.trim()))).slice(0, 40) : nodes.filter((node) => item.suggestedNodeIds.includes(node.id)).slice(0, 8);
	const options = [...new Map([...(suggested ? [suggested] : []), ...(chosen ? [chosen] : []), ...filtered].map((node) => [node.id, node])).values()];
	const discuss = async () => {
		if (!question.trim()) return;
		setBusy(true); setError("");
		try {
			const response = await fetch("/api/mistakes/recall-fsrs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "suggest", ids: [item.id], discussion: { question, history }, ...(preferredRole ? { preferredRole } : {}) }) });
			const body = await response.json() as { items?: Suggestion[]; error?: string };
			if (!response.ok || !body.items?.[0]) throw new Error(body.error || "Could not ask the analyst.");
			const result = body.items[0]; setHistory((prev) => [...prev, { role: "user" as const, text: question }, { role: "assistant" as const, text: result.reason }].slice(-12)); setQuestion("");
			await refresh();
		} catch (err) { setError(err instanceof Error ? err.message : "Could not ask the analyst."); }
		finally { setBusy(false); }
	};
	return <details className="rounded border bg-background p-2.5"><summary className="cursor-pointer"><strong>{verdictLabels[item.verdict]}</strong> · {item.sessionTitle}{selection?.nodeId && <span> · Selected: {chosen?.name}</span>}<ToolContentResponse className="mt-1">{item.draft.question}</ToolContentResponse></summary>
		<div className="mt-2 space-y-2"><div><strong>Your answer:</strong><ToolContentResponse>{item.draft.yourAnswer}</ToolContentResponse></div>
			{item.strengths && <div><strong>What was right:</strong><ToolContentResponse>{presentMistakeAnalysis(item.strengths)}</ToolContentResponse></div>}{item.missing && <div><strong>What was missing:</strong><ToolContentResponse>{presentMistakeAnalysis(item.missing)}</ToolContentResponse></div>}
			{item.assessmentSource === "user" && <p>Your saved assessment: {verdictLabels[item.effectiveVerdict ?? item.verdict]}</p>}
			<RecallAssessmentEditor id={item.id} verdict={item.verdict} onSaved={() => { onRemove(); void refresh(); }} />
			{item.aiSuggestionIssue && <p role="note">{item.aiSuggestionIssue}</p>}
			{item.aiSuggestion && <div className="rounded border bg-muted/30 p-2"><strong>AI suggestion:</strong> {suggested?.name ?? "No suitable concept"}{suggested && <p>{suggested.statement}</p>}<ToolContentResponse>{item.aiSuggestion.reason}</ToolContentResponse><span className="text-muted-foreground">{item.aiSuggestion.model} · verify before saving</span>{suggested && <button type="button" disabled={suggested.reviewedFlashcard} onClick={() => onSelect({ nodeId: suggested.id })} className="ml-2 rounded border px-2 py-1">Select suggested concept</button>}</div>}
			<label className="block">Search concepts<input aria-label="Search concepts" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type a concept name or keyword" className="mt-1 w-full rounded border bg-background p-1" /></label>
			<label className="block">Concept<select aria-label="Concept" value={selection?.nodeId ?? ""} onChange={(event) => onSelect({ nodeId: event.target.value })} className="mt-1 w-full rounded border bg-background p-1"><option value="">Choose a concept</option>{options.map((node) => <option key={node.id} value={node.id} disabled={node.reviewedFlashcard}>{node.name}{node.id === suggested?.id ? " · AI suggestion" : ""}{node.reviewedFlashcard ? " · existing reviewed card" : ""}</option>)}</select></label>
			{selection?.nodeId && !chosen && <p role="alert">The selected concept no longer exists. Choose another before saving.</p>}
			<p className="text-muted-foreground">Search all concepts, with or without accents.{query && filtered.length === 40 ? " Showing the first 40 matches." : ""}</p>{chosen && <p className="text-muted-foreground">{chosen.statement}{chosen.reviewedFlashcard ? " · This concept already has a reviewed Flashcard and cannot be imported." : ""}</p>}
			<label className="block">FSRS rating<select aria-label="FSRS rating" value={selection?.rating ?? defaultRating(item.verdict)} onChange={(event) => onSelect({ rating: Number(event.target.value) })} className="ml-2 rounded border bg-background p-1"><option value={0}>Choose rating</option><option value={1}>1 · Again</option><option value={2}>2 · Hard</option><option value={3}>3 · Good</option><option value={4}>4 · Easy</option></select></label>
			{selection && <button type="button" onClick={onRemove} className="rounded border px-2 py-1">Remove from batch</button>}
			<details className="rounded border p-2"><summary className="cursor-pointer">Discuss this mapping with AI</summary><p className="my-1 text-muted-foreground">Model: {modelLabel}. Sends this answer and the concept list. A new suggestion does not change FSRS.</p>{history.map((message, index) => <div key={index}><strong>{message.role === "user" ? "You" : "AI"}:</strong> <ToolContentResponse>{message.text}</ToolContentResponse></div>)}<textarea aria-label="Ask about this mapping" value={question} onChange={(event) => setQuestion(event.target.value)} className="mt-2 w-full rounded border bg-background p-1" placeholder="Why this concept? Could another be a better match?" /><button type="button" disabled={busy || !question.trim()} onClick={() => void discuss()} className="rounded border px-2 py-1 disabled:opacity-40">{busy ? "Asking…" : "Ask AI"}</button>{error && <p role="alert">{error}</p>}</details>
		</div>
	</details>;
}

export function RecallFsrsReview() {
	const [data, setData] = useState<{ nodes: Node[]; results: Result[]; lastBatch: { id: string; count: number } | null; availableRoles: Array<{ role: string; label: string; modelLabel: string }> } | null>(null);
	const [selected, setSelected] = useState<Record<string, Selection>>({});
	const [page, setPage] = useState(0);
	const [reviewing, setReviewing] = useState(false);
	const [undoing, setUndoing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [suggesting, setSuggesting] = useState(false);
	const [preferredRole, setPreferredRole] = useState("");
	const controller = useRef<AbortController | null>(null);
	const refresh = useCallback(async () => {
		const response = await fetch("/api/mistakes/recall-fsrs", { cache: "no-store" });
		const value = await response.json() as { nodes?: Node[]; results?: Result[]; lastBatch?: { id: string; count: number } | null; availableRoles?: Array<{ role: string; label: string; modelLabel: string }>; error?: string };
		if (!response.ok || !Array.isArray(value.nodes) || !Array.isArray(value.results)) throw new Error(value.error || "Could not load recall reviews.");
		setData({ nodes: value.nodes, results: value.results, lastBatch: value.lastBatch ?? null, availableRoles: value.availableRoles ?? [] });
	}, []);
	useEffect(() => { void refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load recall reviews.")); }, [refresh]);
	const available = useMemo(
		() => (data?.results ?? [])
			.filter((item) => !item.applied)
			.map((item, index) => ({ item, index, ts: item.draft?.answeredAt ? Date.parse(item.draft.answeredAt) || 0 : 0 }))
			.sort((a, b) => b.ts - a.ts || a.index - b.index)
			.map((entry) => entry.item),
		[data],
	);
	const nodes = useMemo(() => new Map((data?.nodes ?? []).map((node) => [node.id, node])), [data]);
	const chosen = Object.entries(selected);
	const ready = chosen.length > 0 && chosen.length <= 100 && chosen.every(([, selection]) => selection.nodeId && nodes.has(selection.nodeId) && !nodes.get(selection.nodeId)?.reviewedFlashcard && selection.rating >= 1 && selection.rating <= 4);
	const modelLabel = data?.availableRoles.find((entry) => entry.role === (preferredRole || "analyst"))?.modelLabel ?? "Analyst (configured model)";
	const suggestPage = async () => {
		const pageItems = available.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).filter((item) => !item.aiSuggestion);
		if (!pageItems.length) { setNotice("This page already has saved suggestions. Open an answer to discuss its mapping."); return; }
		setSuggesting(true); setError(""); controller.current = new AbortController();
		const failures: string[] = [];
		try {
			for (let offset = 0; offset < pageItems.length; offset += 10) {
				const batch = pageItems.slice(offset, offset + 10); setNotice(`Requesting suggestions: ${offset} / ${pageItems.length} answers on this page.`);
				const response = await fetch("/api/mistakes/recall-fsrs", { method: "POST", signal: controller.current.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "suggest", ids: batch.map((item) => item.id), ...(preferredRole ? { preferredRole } : {}) }) });
				const body = await response.json() as { items?: Suggestion[]; error?: string; failures?: Array<{ ids: string[]; error: string }> };
				if (!response.ok || !body.items) { failures.push(`Batch ${Math.floor(offset / 10) + 1}: ${body.error || "Could not suggest concepts."}`); break; }
				for (const failure of body.failures ?? []) failures.push(`Batch ${Math.floor(offset / 10) + 1}, ${failure.ids.length} answers: ${failure.error}`);
				setSelected((previous) => { const next = { ...previous }; for (const suggestion of body.items ?? []) { const item = batch.find((entry) => entry.id === suggestion.answerId); if (item && suggestion.nodeId && !next[item.id]) next[item.id] = { nodeId: suggestion.nodeId, rating: defaultRating(item.effectiveVerdict ?? item.verdict) }; } return next; });
				await refresh();
				if (body.failures?.some((failure) => /quota|rate limit|authenticate|cancelled/i.test(failure.error))) break;
			}
			setNotice("Completed batches saved. Review each concept, reason and rating before confirming FSRS.");
			if (failures.length) setError(failures.join(" "));
		} catch (err) { await refresh().catch(() => {}); setError(err instanceof Error ? err.message : "Could not suggest concepts."); }
		finally { setSuggesting(false); controller.current = null; }
	};
	const save = async () => {
		if (!ready) return;
		setBusy(true); setError("");
		try {
			const response = await fetch("/api/mistakes/recall-fsrs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: chosen.map(([answerId, value]) => ({ answerId, ...value, answerRevision: data?.results.find((item) => item.id === answerId)?.revision, nodeRevision: nodes.get(value.nodeId)?.revision })) }) });
			const body = await response.json() as { added?: number; error?: string };
			if (!response.ok) throw new Error(body.error || "Could not save reviews.");
			setSelected({}); setReviewing(false); setNotice(`Saved ${body.added ?? 0} confirmed recall reviews.`);
			await refresh(); window.dispatchEvent(new Event("lh:graph-revision"));
		} catch (err) { setError(err instanceof Error ? err.message : "Could not save reviews."); }
		finally { setBusy(false); }
	};
	const undo = async () => {
		if (!data?.lastBatch) return;
		setBusy(true); setError("");
		try {
			const response = await fetch("/api/mistakes/recall-fsrs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "undo", batchId: data.lastBatch.id }) });
			const body = await response.json() as { undone?: number; error?: string };
			if (!response.ok) throw new Error(body.error || "Could not undo the import.");
			setUndoing(false); setNotice(`Undid ${body.undone ?? 0} recall reviews.`); await refresh(); window.dispatchEvent(new Event("lh:graph-revision"));
		} catch (err) { setError(err instanceof Error ? err.message : "Could not undo the import."); }
		finally { setBusy(false); }
	};
	return <section className="space-y-3 rounded-xl border bg-card p-4 text-xs" aria-label="Connect recall to FSRS">
		<h2 className="font-medium">Connect free recall to FSRS</h2>
		<p className="text-muted-foreground">Ask the configured analyst model to suggest concepts for this page, then review the reason and rating. This sends the answers and graph concepts to that model and can use tokens. No FSRS review is saved until you confirm. Reviews use the original answer time and do not create Flashcards.</p>
		<p className="text-muted-foreground">Concepts with an existing reviewed Flashcard cannot be imported here yet. Recall and Flashcards histories are stored separately; if a Flashcard for the same concept is later reviewed, the Flashcard schedule takes precedence.</p>
		{error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
		{!data ? <p>Loading…</p> : <>
			<p>{available.length} answers available · {data.results.length - available.length} already linked</p>
			{data.lastBatch && !reviewing && <div className="flex flex-wrap items-center gap-2">{undoing ? <><span>Undo the latest {data.lastBatch.count} reviews?</span><button type="button" disabled={busy} onClick={() => void undo()} className="rounded border px-2 py-1">Confirm undo</button><button type="button" onClick={() => setUndoing(false)} className="rounded border px-2 py-1">Cancel</button></> : <button type="button" onClick={() => setUndoing(true)} className="rounded border px-2 py-1">Undo last import</button>}</div>}
			{reviewing ? <div className="space-y-2 rounded border p-3"><p className="font-medium">Confirm these {chosen.length} reviews</p><p className="text-muted-foreground">Each rating changes the separate recall-based FSRS estimate from the original date.</p><div className="max-h-72 space-y-1 overflow-auto">{chosen.map(([id, selection]) => { const result = data.results.find((item) => item.id === id); return <div key={id} className="rounded border p-2"><strong>{nodes.get(selection.nodeId)?.name}</strong> · rating {selection.rating} · {result?.draft.answeredAt ? new Date(result.draft.answeredAt).toLocaleString() : "unknown date"}<ToolContentResponse>{result?.draft.question ?? ""}</ToolContentResponse>{result?.aiSuggestion?.nodeId === selection.nodeId && <ToolContentResponse>{result.aiSuggestion.reason}</ToolContentResponse>}</div>; })}</div><div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void save()} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Confirm and save</button><button type="button" disabled={busy} onClick={() => setReviewing(false)} className="rounded border px-3 py-1.5">Back</button></div></div> : <>
				<div className="flex flex-wrap items-center gap-2"><label>Model for this request <select value={preferredRole} onChange={(event) => setPreferredRole(event.target.value)} disabled={suggesting} className="rounded border bg-background p-1"><option value="">Analyst (default)</option>{data.availableRoles.map((role) => <option key={role.role} value={role.role}>{role.label} · {role.modelLabel}</option>)}</select></label><span>{modelLabel}</span></div>
				<button type="button" disabled={suggesting || busy || available.length === 0} onClick={() => void suggestPage()} className="rounded border px-3 py-1.5 disabled:opacity-40">{suggesting ? "Suggesting…" : "Suggest concepts with AI for this page"}</button>{suggesting && <button type="button" onClick={() => controller.current?.abort()} className="ml-2 rounded border px-2 py-1">Cancel</button>}
				<div className="space-y-2">{available.slice(Math.min(page, Math.max(1, Math.ceil(available.length / PAGE_SIZE)) - 1) * PAGE_SIZE, (Math.min(page, Math.max(1, Math.ceil(available.length / PAGE_SIZE)) - 1) + 1) * PAGE_SIZE).map((item) => {
					const selection = selected[item.id];
					const setSelection = (part: Partial<Selection>) => setSelected((previous) => ({ ...previous, [item.id]: { nodeId: previous[item.id]?.nodeId ?? "", rating: previous[item.id]?.rating ?? defaultRating(item.effectiveVerdict ?? item.verdict), ...part } }));
					return <MappingCard key={item.id} item={item} nodes={data.nodes} selection={selection} onSelect={setSelection} onRemove={() => setSelected((previous) => { const next = { ...previous }; delete next[item.id]; return next; })} refresh={refresh} preferredRole={preferredRole} modelLabel={modelLabel} />;
				})}</div><PageControls page={page} totalPages={Math.max(1, Math.ceil(available.length / PAGE_SIZE))} onPageChange={setPage} /><button type="button" disabled={!ready || busy} onClick={() => setReviewing(true)} className="rounded border px-3 py-1.5 disabled:opacity-40">Review batch ({chosen.length})</button>
			</>}
		</>}
	</section>;
}

"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DailyStudyPlan, PlannerConfig } from "@/src/core";
import { PlannerCoachChat, type CoachProposalPreview } from "@/components/planner-coach-chat";

type Focus = "schedule" | "lifestyle" | "general";
type Snapshot = { config: PlannerConfig; plan: DailyStudyPlan; aiAvailability: { coach: { available: boolean; modelLabel: string | null }; availableRoles?: Array<{ role: string; label: string; modelLabel: string }> } };

/** The home screen uses the same Coach endpoint, conversation and confirmation gate as Planner. */
export function GlobalPlannerCoach({ onClose }: { onClose: () => void }) {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [focus, setFocus] = useState<Focus>("general");
	const [role, setRole] = useState("");
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [proposal, setProposal] = useState<CoachProposalPreview | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
	const [offset, setOffset] = useState({ x: 0, y: 0 });
	useEffect(() => { const resetPosition = () => setOffset({ x: 0, y: 0 }); window.addEventListener("resize", resetPosition); return () => window.removeEventListener("resize", resetPosition); }, []);
	useEffect(() => { let alive = true; void fetch("/api/planner", { cache: "no-store" }).then(async (res) => { if (!res.ok) throw new Error("Could not load Coach."); return await res.json() as Snapshot; }).then((data) => { if (alive) setSnapshot(data); }).catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load Coach."); }); return () => { alive = false; }; }, []);
	const post = useCallback(async (body: Record<string, unknown>, files: File[] = []) => {
		setBusy(true); setError("");
		try {
			const form = new FormData(); form.set("payload", JSON.stringify(body)); for (const file of files) form.append("files", file);
			const res = await fetch("/api/planner/coach", files.length ? { method: "POST", body: form } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const result = await res.json() as { snapshot?: Snapshot; proposal?: CoachProposalPreview; error?: string; undone?: boolean; reason?: string };
			if (!res.ok || result.undone === false) throw new Error(result.error || result.reason || "Coach request failed.");
			if (result.snapshot) setSnapshot(result.snapshot);
			if (result.proposal) setProposal(result.proposal);
			if (body.action === "confirm" || body.action === "undo") window.dispatchEvent(new Event("lh:graph-revision"));
			return true;
		} catch (err) { setError(err instanceof Error ? err.message : "Coach request failed."); return false; }
		finally { setBusy(false); }
	}, []);
	const close = useCallback(() => {
		if (proposal) void post({ action: "discard", proposalId: proposal.id });
		onClose();
	}, [proposal, post, onClose]);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); close(); }
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [close]);
	const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
		dragRef.current = { x: event.clientX, y: event.clientY, dx: offset.x, dy: offset.y };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const start = dragRef.current, panel = panelRef.current, parent = panel?.parentElement;
		if (!start || !panel || !parent) return;
		const rect = panel.getBoundingClientRect(), bounds = parent.getBoundingClientRect();
		const x = Math.max(offset.x + bounds.left - rect.left, Math.min(start.dx + event.clientX - start.x, offset.x + bounds.right - rect.right));
		const y = Math.max(offset.y + bounds.top + 48 - rect.top, Math.min(start.dy + event.clientY - start.y, offset.y + bounds.bottom - rect.bottom));
		setOffset({ x, y });
	};
	return <div ref={panelRef} role="complementary" aria-label="Coach" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }} className="lh-no-drag absolute right-3 top-14 z-50 flex h-[min(700px,calc(100%-4.25rem))] w-[min(420px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border bg-card shadow-xl">
		<div onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} className="lh-no-drag flex shrink-0 cursor-move items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1 text-xs touch-none"><span>Move Coach</span><button type="button" onClick={close} aria-label="Close Coach window" className="lh-no-drag rounded border bg-card px-2 py-1 hover:bg-accent">Close ×</button></div>
		{error && <div role="alert" className="border-b p-2 text-xs text-destructive">{error}</div>}
		{snapshot ? <PlannerCoachChat embedded messages={snapshot.config.coachChat ?? []} lastUndoMessageId={snapshot.config.lastCoachUndo?.messageId} focusArea={focus} onChangeFocusArea={setFocus} coachAvailable={snapshot.aiAvailability.coach.available} coachModelLabel={snapshot.aiAvailability.coach.modelLabel} availableRoles={snapshot.aiAvailability.availableRoles} selectedRole={role} onChangeRole={setRole} sending={busy} draftText={draft} onDraftChange={setDraft} onSend={async (message, area, files) => { if (proposal) { setError("Review or discard the current proposal first."); return false; } return post({ action: "send", message, date: snapshot.plan.date, focusArea: area ?? focus, ...(role ? { preferredRole: role } : {}) }, files); }} onUndo={async (messageId) => { await post({ action: "undo", messageId, date: snapshot.plan.date }); }} onClear={async () => { if (proposal) { await post({ action: "discard", proposalId: proposal.id }); setProposal(null); } await post({ action: "clear", date: snapshot.plan.date }); }} onClose={close} proposal={proposal} onProposalDecision={async (apply) => { if (proposal && await post({ action: apply ? "confirm" : "discard", proposalId: proposal.id })) setProposal(null); }} /> : <div className="p-4 text-xs"><button type="button" className="rounded border px-2 py-1" onClick={close}>Close</button>{!error && <p className="mt-2">Loading Coach…</p>}</div>}
	</div>;
}

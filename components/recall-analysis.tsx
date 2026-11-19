"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LearningCapacityReport } from "@/src/core";
import { presentMistakeAnalysis, recallAnswerHref } from "@/src/core";
import type { RecallGroup } from "@/src/core";
import type { RecallScanResult } from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { PageControls } from "@/components/page-controls";
import { RecallAssessmentEditor } from "@/components/recall-assessment-editor";
import { RecallAudit } from "@/components/recall-audit";
import { RecallCapacityEvidence } from "@/components/recall-capacity-evidence";

type Row = LearningCapacityReport["subjectBreakdown"][number];
type PreviewItem = { id: string; fingerprint: string; topic: string; errorType: string; verdict?: string; source?: string; feedback: string; needsReview?: boolean; chatId: string; sourceMessageId?: string; toolCallId?: string };
type Preview = { subject: string; totalAnswers: number; totalEligible: number; limit: number; offset: number; model: string; availableRoles: Array<{ role: string; label: string; modelLabel: string; pricing?: { input: number; output: number } | null }>; items: PreviewItem[]; allItems: PreviewItem[]; groups: RecallGroup[]; draft: RecallGroup[] | null; history?: Array<{ id: string; createdAt: string; model: string; groups: RecallGroup[] }>; approvedRevision: string };
type GroupJob = { id: string; subject: string; model: string; status: string; items: Array<{ id: string }>; completed: string[]; skipped: Array<{ id: string; reason: string }>; groups: RecallGroup[]; usage: { input: number; output: number; calls: number }; error?: string; createdAt: string };
const splitKey = (groupId: string, answerId: string) => JSON.stringify([groupId, answerId]);

export function RecallAnalysis({ report, onRefresh, section = "all", visible = true, evidenceId, onEvidenceOpened }: {
	report: LearningCapacityReport;
	onRefresh: () => Promise<void>;
	section?: "all" | "recall" | "groups";
	visible?: boolean;
	evidenceId?: string;
	onEvidenceOpened?: () => void;
}) {
	const showGroups = section !== "recall";
	const showSummary = section !== "groups";
	const [subject, setSubject] = useState("");
	const [resumeSubject, setResumeSubject] = useState("");
	const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
	const [returnReviewOpen, setReturnReviewOpen] = useState(true);
	const [returnAnswer, setReturnAnswer] = useState<{ id: string; source?: { chatId: string; sourceMessageId?: string; toolCallId?: string } } | null>(null);
	useEffect(() => {
		let current = "";
		try {
			current = sessionStorage.getItem("lh:recall-return-subject") ?? "";
			const saved = JSON.parse(sessionStorage.getItem("lh:recall-return-state") ?? "null") as {
				range?: "last30" | "allTime"; expanded?: Record<string, boolean>; reviewOpen?: boolean; groupPage?: number; previewPage?: number; answer?: NonNullable<typeof returnAnswer>;
			} | null;
			if (current || saved) {
				if (saved?.range) setRange(saved.range);
				if (saved?.expanded) setExpandedGroups(saved.expanded);
				if (saved?.reviewOpen === false) setReturnReviewOpen(false);
				if (typeof saved?.groupPage === "number" && Number.isInteger(saved.groupPage) && saved.groupPage >= 0) setGroupPage(saved.groupPage);
				if (typeof saved?.previewPage === "number" && Number.isInteger(saved.previewPage) && saved.previewPage >= 0) setPreviewPage(saved.previewPage);
				if (saved?.answer?.id) setReturnAnswer(saved.answer);
				if (report.subjectBreakdown.some((item) => item.subject === current)) {
					setSubject(current); setResumeSubject(current);
				}
				sessionStorage.removeItem("lh:recall-return-state");
				sessionStorage.removeItem("lh:recall-return-subject");
				return;
			}
		} catch { /* storage unavailable */ }
		void fetch("/api/planner/recall-progress?key=meta%3Agroup", { cache: "no-store" }).then(async (res) => {
			if (!res.ok) return;
			const body = await res.json() as { progress?: { value?: { subject?: string; scrollTop?: number; groupPage?: number; previewPage?: number; range?: "last30" | "allTime"; expanded?: Record<string, boolean> } } };
			const saved = body.progress?.value;
			if (saved?.subject && report.subjectBreakdown.some((item) => item.subject === saved.subject)) {
				setSubject(saved.subject); setResumeSubject(saved.subject);
				if (saved.range) setRange(saved.range); if (saved.expanded) setExpandedGroups(saved.expanded);
				if (Number.isInteger(saved.groupPage) && saved.groupPage! >= 0) setGroupPage(saved.groupPage!);
				if (Number.isInteger(saved.previewPage) && saved.previewPage! >= 0) setPreviewPage(saved.previewPage!);
				try { if (saved.scrollTop) sessionStorage.setItem("lh:recall-return-scroll", String(saved.scrollTop)); } catch { /* storage unavailable */ }
			}
		}).catch(() => {});
	}, []);
	const resumeRequested = useRef(false);
	const progressSequence = useRef(0);
	const pendingProgress = useRef<{ subject: string; sequence: number; payload: string } | null>(null);
	const progressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const flushProgress = useCallback(() => {
		const pending = pendingProgress.current; pendingProgress.current = null;
		if (!pending) return;
		void fetch("/api/planner/recall-progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: pending.payload, keepalive: pending.payload.length < 60000 }).then((response) => { if (!response.ok) throw new Error("save failed"); if (progressSequence.current === pending.sequence) setProgressStatus("Review progress saved on this device."); }).catch(() => { if (progressSequence.current === pending.sequence) setProgressStatus("Could not save review progress; keep this window open and try again."); });
	}, []);
	useEffect(() => () => { if (progressTimer.current) clearTimeout(progressTimer.current); flushProgress(); }, [flushProgress]);
	const locationSequence = useRef(0);
	const [progressStatus, setProgressStatus] = useState("");
	const [range, setRange] = useState<"last30" | "allTime">("last30");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [groups, setGroups] = useState<RecallGroup[]>([]);
	const [groupJobs, setGroupJobs] = useState<GroupJob[]>([]);
	const [groupJobId, setGroupJobId] = useState("");
	const [removedGroups, setRemovedGroups] = useState<Record<string, boolean>>({});
	const [groupPage, setGroupPage] = useState(0);
	const [previewPage, setPreviewPage] = useState(0);
	useEffect(() => { if (preview) setGroupPage((page) => Math.min(page, Math.max(0, Math.ceil(groups.length / 10) - 1))); }, [preview, groups.length]);
	useEffect(() => { if (preview) setPreviewPage((page) => Math.min(page, Math.max(0, Math.ceil(preview.items.length / 10) - 1))); }, [preview]);
	const [approved, setApproved] = useState<Record<string, boolean>>({});
	const [splitSelection, setSplitSelection] = useState<Record<string, boolean>>({});
	const [role, setRole] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [answerView, setAnswerView] = useState<{ answer: RecallScanResult & { effectiveVerdict?: RecallScanResult["verdict"]; assessmentSource?: "ai" | "user" | "unassessed"; assessmentStale?: boolean; tutorFeedback?: string }; mistake: { status: string } | null; source?: { chatId: string; sourceMessageId?: string; toolCallId?: string } } | null>(null);
	const subjects = report.subjectBreakdown.filter((item) => item.recallInsights?.allTime.responses > 0);
	const row: Row | undefined = subjects.find((item) => item.subject === subject) ?? subjects[0];
	const activeSubject = row?.subject ?? "";
	const window = row?.recallInsights[range];
	const selectedModel = preview?.availableRoles.find((item) => item.role === role)?.modelLabel ?? preview?.model;
	const groupingPrice = preview?.availableRoles.find((item) => item.role === (role || "analyst"))?.pricing;
	const groupingInput = preview ? Math.ceil(preview.items.reduce((sum, item) => sum + item.topic.length + item.feedback.length + 180, 0) / 3 + Math.ceil(preview.items.length / 20) * 500) : 0;
	const groupingCost = groupingPrice && preview ? (groupingInput * groupingPrice.input + preview.items.length * 100 * groupingPrice.output) / 1000000 : null;
	useEffect(() => {
		if (!preview || preview.subject !== activeSubject) return;
		const sequence = Math.max(progressSequence.current + 1, Date.now() * 1000); progressSequence.current = sequence;
		const value = { groups, approved, splitSelection, removedGroups, revision: preview.approvedRevision, sequence };
		try { localStorage.setItem(`lh:recall-review:${activeSubject}`, JSON.stringify(value)); } catch { /* server copy remains authoritative */ }
		setProgressStatus("Saving review progress…");
		const payload = JSON.stringify({ key: `group:${activeSubject}`, sequence, value });
		if (pendingProgress.current && pendingProgress.current.subject !== activeSubject) flushProgress();
		pendingProgress.current = { subject: activeSubject, sequence, payload };
		if (progressTimer.current) clearTimeout(progressTimer.current);
		progressTimer.current = setTimeout(flushProgress, 450);
	}, [preview, activeSubject, groups, approved, splitSelection, removedGroups, flushProgress]);
	const openAnswer = async (id: string, source?: { chatId: string; sourceMessageId?: string; toolCallId?: string }) => {
		setError("");
		try { const res = await fetch(`/api/planner/recall-groups?answerId=${encodeURIComponent(id)}`, { cache: "no-store" }); const body = await res.json(); if (!res.ok) throw new Error(body.error || "Could not load answer."); setAnswerView({ ...body, source: source ?? body.source }); }
		catch (err) { setError(err instanceof Error ? err.message : "Could not load answer."); }
	};
	useEffect(() => {
		if (!visible || !returnAnswer) return;
		setReturnAnswer(null);
		void openAnswer(returnAnswer.id, returnAnswer.source);
	}, [returnAnswer, visible]);
	const lastEvidence = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!evidenceId) { lastEvidence.current = undefined; return; }
		if (lastEvidence.current === evidenceId) return;
		lastEvidence.current = evidenceId;
		void openAnswer(evidenceId).finally(() => onEvidenceOpened?.());
	}, [evidenceId]);
	const removeCurrentMistake = async () => {
		if (!answerView || !globalThis.confirm("Remove this entry from Mistakes? Its chat and FSRS reviews will remain unchanged.")) return;
		try {
			const response = await fetch(`/api/mistakes/${encodeURIComponent(answerView.answer.id)}`, { method: "DELETE" });
			if (!response.ok) throw new Error("Could not remove this Mistakes entry.");
			setAnswerView((old) => old ? { ...old, mistake: null } : old);
			setNotice("Removed from Mistakes. The original answer and FSRS reviews remain unchanged.");
			await onRefresh();
		} catch (err) { setError(err instanceof Error ? err.message : "Could not remove this Mistakes entry."); }
	};
	const loadPreview = async (offset = 0) => {
		setBusy(true); setError(""); setNotice("");
		try {
			const res = await fetch(`/api/planner/recall-groups?subject=${encodeURIComponent(activeSubject)}&offset=${offset}`, { cache: "no-store" });
			const value = await res.json() as Preview & { error?: string };
			if (!res.ok) throw new Error(value.error || "Could not load the preview.");
			const editable = value.draft ? [...value.groups.filter((group) => !value.draft!.some((draft) => draft.id === group.id)), ...value.draft] : value.groups;
			type SavedProgress = { groups: RecallGroup[]; approved: Record<string, boolean>; splitSelection: Record<string, boolean>; removedGroups?: Record<string, boolean>; revision: string; sequence?: number };
			let progress: SavedProgress | null = null;
			try { progress = JSON.parse(localStorage.getItem(`lh:recall-review:${activeSubject}`) ?? "null"); } catch { /* unreadable legacy progress */ }
			try { const saved = await fetch(`/api/planner/recall-progress?key=${encodeURIComponent(`group:${activeSubject}`)}`, { cache: "no-store" }); if (!saved.ok) throw new Error("Could not read saved progress."); const remote = await saved.json() as { progress?: { sequence: number; value: SavedProgress } | null }; if (remote.progress && remote.progress.sequence > (progress?.sequence ?? 0)) progress = remote.progress.value; } catch { setError("Could not read saved review progress; local browser progress may still be available."); }
			const restored = progress?.revision === value.approvedRevision && Array.isArray(progress.groups) ? progress : null;
			const selection: Record<string, boolean> = {};
			for (const group of restored?.groups ?? []) for (const member of group.members) {
				const key = splitKey(group.id, member.id);
				if (restored?.splitSelection?.[key] ?? restored?.splitSelection?.[member.id]) selection[key] = true;
			}
			setPreview(value); setGroups(restored?.groups ?? editable); setApproved(restored?.approved ?? Object.fromEntries(value.groups.map((group) => [group.id, true]))); setSplitSelection(selection); setRemovedGroups(restored?.removedGroups ?? {});
			try { const offset = Number(sessionStorage.getItem("lh:recall-return-scroll")); if (Number.isFinite(offset) && offset > 0) { sessionStorage.removeItem("lh:recall-return-scroll"); setTimeout(() => { const scroller = document.querySelector("[data-testid=planner-capacity-modal] .overflow-y-auto"); if (scroller) scroller.scrollTop = offset; }, 100); } } catch { /* storage unavailable */ }
			if (value.draft) setNotice("Restored local unapproved suggestions. The existing approved groups remain in the report until you save a new selection.");
		} catch (err) { setError(err instanceof Error ? err.message : "Could not load the preview."); }
		finally { setBusy(false); }
	};
	useEffect(() => {
		if (!visible || (!showGroups && returnReviewOpen) || !resumeSubject || activeSubject !== resumeSubject || preview || resumeRequested.current) return;
		resumeRequested.current = true;
		try { sessionStorage.removeItem("lh:recall-return-subject"); } catch { /* storage unavailable */ }
		if (returnReviewOpen) void loadPreview();
		else { try { const offset = Number(sessionStorage.getItem("lh:recall-return-scroll")); sessionStorage.removeItem("lh:recall-return-scroll"); setTimeout(() => { const scroller = document.querySelector("[data-testid=planner-capacity-modal] .overflow-y-auto"); if (scroller && offset > 0) scroller.scrollTop = offset; }, 100); } catch { /* storage unavailable */ } }
	// The restore runs once after the requested subject is available.
	}, [activeSubject, preview, resumeSubject, returnReviewOpen, showGroups, visible]);
	useEffect(() => {
		if (!visible || !showGroups || !preview || preview.subject !== activeSubject) return;
		const scroller = document.querySelector("[data-testid=planner-capacity-modal] .overflow-y-auto");
		if (!scroller) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let lastScroll = scroller.scrollTop;
		const persistLocation = () => {
			const sequence = Math.max(locationSequence.current + 1, Date.now() * 1000); locationSequence.current = sequence;
			void fetch("/api/planner/recall-progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "meta:group", sequence, value: { subject: activeSubject, scrollTop: lastScroll, groupPage, previewPage, range, expanded: expandedGroups } }), keepalive: true }).catch(() => {});
		};
		const onScroll = () => { lastScroll = scroller.scrollTop; if (timer) clearTimeout(timer); timer = setTimeout(persistLocation, 500); };
		scroller.addEventListener("scroll", onScroll);
		timer = setTimeout(() => { lastScroll = scroller.scrollTop; persistLocation(); }, 0);
		return () => { scroller.removeEventListener("scroll", onScroll); if (timer) { clearTimeout(timer); persistLocation(); } };
	}, [activeSubject, preview?.subject, groupPage, previewPage, range, expandedGroups, visible, showGroups]);
	const refreshGroupJobs = useCallback(async () => {
		if (!activeSubject || !preview || preview.subject !== activeSubject) return;
		const response = await fetch(`/api/planner/recall-groups?jobs=1&subject=${encodeURIComponent(activeSubject)}`, { cache: "no-store" });
		const body = await response.json() as { jobs?: GroupJob[]; error?: string };
		if (!response.ok) throw new Error(body.error || "Could not load grouping progress.");
		const jobs = body.jobs ?? []; setGroupJobs(jobs);
		setGroupJobId((id) => jobs.some((job) => job.id === id) ? id : jobs.at(-1)?.id ?? "");
	}, [activeSubject, preview?.subject]);
	useEffect(() => { if (visible && showGroups) void refreshGroupJobs().catch(() => {}); }, [refreshGroupJobs, visible, showGroups]);
	const groupJob = groupJobs.find((job) => job.id === groupJobId);
	useEffect(() => {
		if (!groupJob || groupJob.subject !== activeSubject) return;
		const deduped = groupJob.groups.filter((item, index, list) => {
			const ids = new Set(item.members.map((member) => member.id));
			const normName = item.name.trim().toLocaleLowerCase();
			return !list.some((other, otherIndex) => {
				if (otherIndex <= index || other.name.trim().toLocaleLowerCase() !== normName) return false;
				const otherIds = new Set(other.members.map((member) => member.id));
				return ids.size <= otherIds.size && [...ids].every((id) => otherIds.has(id));
			});
		});
		setGroups((old) => { const seen = new Set(old.map((item) => item.id)); const fresh = deduped.filter((item) => !seen.has(item.id) && !removedGroups[item.id]); return fresh.length ? [...old, ...fresh] : old; });
	}, [activeSubject, groupJob, removedGroups]);
	useEffect(() => {
		if (!visible || !showGroups || groupJob?.status !== "running") return;
		const timer = setInterval(() => { void refreshGroupJobs().catch(() => {}); }, 4000);
		return () => clearInterval(timer);
	}, [groupJob?.status, refreshGroupJobs, showGroups, visible]);
	const groupAction = async (action: "start_job" | "resume_job" | "pause_job", retrySkipped = false) => {
		if (!preview) return;
		setBusy(true); setError(""); setNotice("");
		try {
			const body = { action, subject: activeSubject, ...(action === "start_job" ? { expected: preview.items.map(({ id, fingerprint }) => ({ id, fingerprint })) } : { jobId: groupJobId }), ...(role ? { preferredRole: role } : {}), ...(retrySkipped ? { retrySkipped: true } : {}) };
			const response = await fetch("/api/planner/recall-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const value = await response.json() as { id?: string; error?: string };
			if (!response.ok) throw new Error(value.error || "Could not update grouping.");
			if (value.id) setGroupJobId(value.id);
			await refreshGroupJobs();
		} catch (err) { setError(err instanceof Error ? err.message : "Could not update grouping."); }
		finally { setBusy(false); }
	};
	const save = async () => {
		if (!preview) return;
		setBusy(true); setError(""); setNotice("");
		try {
			const selected = groups.filter((group) => approved[group.id]);
			if (!selected.length && preview.groups.length && !globalThis.confirm("Remove all approved groups for this subject? Your answers and saved AI runs remain available.")) return;
			const res = await fetch("/api/planner/recall-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", subject: activeSubject, groups: selected, approvedRevision: preview.approvedRevision }) });
			const value = await res.json() as { saved?: number; error?: string };
			if (!res.ok) throw new Error(value.error || "Could not approve groups.");
			localStorage.removeItem(`lh:recall-review:${activeSubject}`); setNotice(`Saved ${value.saved ?? 0} approved groups for this subject.`); setPreview(null); await onRefresh();
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
		const chosen = group.members.filter((member) => splitSelection[splitKey(group.id, member.id)]);
		const rest = group.members.filter((member) => !splitSelection[splitKey(group.id, member.id)]);
		if (!chosen.length || !rest.length) { setError("Select some, but not all, answers to separate."); return; }
		const id = crypto.randomUUID();
		setGroups((old) => [...old.flatMap((item) => item.id === group.id ? rest.length >= 2 ? [{ ...item, members: rest }] : [] : [item]), ...(chosen.length >= 2 ? [{ ...group, id, name: `${group.name} (split)`, members: chosen }] : [])]);
		if (chosen.length < 2 || rest.length < 2) setNotice("A single answer is left ungrouped; all original answers remain available.");
		setApproved((old) => ({ ...old, [group.id]: false, [id]: false }));
		if (rest.length < 2) setRemovedGroups((old) => ({ ...old, [group.id]: true }));
		setSplitSelection((old) => { const next = { ...old }; for (const member of group.members) delete next[splitKey(group.id, member.id)]; return next; }); setError("");
	};
	return <section aria-label="Recall Analysis" className="space-y-3 rounded-xl border bg-background/70 p-4">
		<h3 className="text-sm font-semibold">{section === "groups" ? "Topic Groups" : "Recall Analysis"}</h3>
        {section === "all" && <RecallAudit onApplied={onRefresh} />}
        {answerView && <div role="dialog" aria-label="Answer details" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"><div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded border bg-card p-3 space-y-2">
            <button type="button" onClick={() => setAnswerView(null)} className="rounded border px-2 py-1">Back to review</button>{error && <p role="alert">{error}</p>}
            <p>Question</p><ToolContentResponse>{answerView.answer.draft.question}</ToolContentResponse>
            <p>Your answer</p><ToolContentResponse>{answerView.answer.draft.yourAnswer}</ToolContentResponse>
            <p>Reference answer</p><ToolContentResponse>{answerView.answer.draft.correctAnswer}</ToolContentResponse>
            <p>Assessment: {answerView.answer.assessmentSource === "unassessed" ? "not assessed" : answerView.answer.effectiveVerdict ?? answerView.answer.verdict} ({answerView.answer.assessmentSource === "user" ? "learner correction" : answerView.answer.assessmentSource === "unassessed" ? "no current assessment" : "provisional AI"}) · {answerView.mistake ? answerView.mistake.status === "failed" ? "Mistake explanation failed; this is not a correctness verdict" : `In Mistakes · analysis ${answerView.mistake.status}` : "Not in Mistakes"}</p>
            {answerView.answer.assessmentStale && <p role="note">The original answer changed; its previous assessment needs review.</p>}
            {answerView.answer.tutorFeedback && <><p>Tutor feedback</p><ToolContentResponse>{presentMistakeAnalysis(answerView.answer.tutorFeedback)}</ToolContentResponse></>}
            <ToolContentResponse>{presentMistakeAnalysis(answerView.answer.missing)}</ToolContentResponse>
            {answerView.mistake && (answerView.answer.effectiveVerdict ?? answerView.answer.verdict) === "correct" && <p role="note">This answer is assessed correct but remains in Mistakes. Review both before deciding whether to remove it.</p>}
            {answerView.mistake && <button type="button" onClick={() => void removeCurrentMistake()} className="rounded border px-2 py-1">Remove from Mistakes</button>}
            <RecallAssessmentEditor id={answerView.answer.id} verdict={answerView.answer.effectiveVerdict ?? answerView.answer.verdict} onSaved={() => { void openAnswer(answerView.answer.id, answerView.source); void onRefresh(); }} />
            <a className="underline" onClick={() => { try { sessionStorage.setItem("lh:recall-return-subject", activeSubject); sessionStorage.setItem("lh:recall-return-state", JSON.stringify({ range, expanded: expandedGroups, reviewOpen: showGroups && Boolean(preview), groupPage, previewPage, tab: showGroups ? "groups" : "recall", answer: { id: answerView.answer.id, source: answerView.source } })); const scroller = document.querySelector("[data-testid=planner-capacity-modal] .overflow-y-auto"); if (scroller) sessionStorage.setItem("lh:recall-return-scroll", String(scroller.scrollTop)); } catch { /* storage unavailable */ } }} href={recallAnswerHref(answerView.answer.draft.chatId, answerView.source?.sourceMessageId ?? preview?.allItems.find((item) => item.id === answerView.answer.id)?.sourceMessageId, answerView.source?.toolCallId ?? preview?.allItems.find((item) => item.id === answerView.answer.id)?.toolCallId)}>Open full chat</a>
        </div></div>}
		{showSummary && <><p className="text-muted-foreground">Recall shows your answers and their assessment sources. Recent evidence makes a bounded contribution to the composite.</p>
		<p className="text-muted-foreground">Coverage: {report.dataCoverage.recallAssigned ?? 0} of {report.dataCoverage.recallAnswers ?? 0} eligible recall/explain answers have an identifiable subject; {report.dataCoverage.recallUnassigned ?? 0} are unassigned. The workspace telemetry counter may also include coding questions and uses a different counting method.</p>
		{(report.dataCoverage.recallUnassignedExamples?.length ?? 0) > 0 && <details><summary className="cursor-pointer">View unassigned answers</summary>{report.dataCoverage.recallUnassignedExamples?.map((item, index) => <a key={`${item.chatId}:${item.toolCallId ?? index}`} className="mr-2 underline" href={recallAnswerHref(item.chatId, item.sourceMessageId, item.toolCallId)}>Answer {index + 1}</a>)}</details>}
		</>}
		{!row || !window ? <p>No subject-linked recall answers yet.</p> : <>
			<div className="flex flex-wrap items-center gap-2"><label>Subject <select aria-label="Recall subject" value={activeSubject} onChange={(event) => { setSubject(event.target.value); setPreview(null); setGroupJobs([]); setGroupJobId(""); setGroups([]); setRemovedGroups({}); setApproved({}); setSplitSelection({}); setGroupPage(0); setPreviewPage(0); setError(""); setNotice(""); }} className="rounded border bg-background p-1">{subjects.map((item) => <option key={item.subject} value={item.subject}>{item.subject}</option>)}</select></label><span>Period:</span><button type="button" aria-pressed={range === "last30"} onClick={() => setRange("last30")} className="rounded border px-2 py-1 aria-pressed:bg-accent">Last 30 days</button><button type="button" aria-pressed={range === "allTime"} onClick={() => setRange("allTime")} className="rounded border px-2 py-1 aria-pressed:bg-accent">All time</button></div>
			{showSummary && <div className="rounded border p-3 space-y-1"><p><strong>{window.responses}</strong> answers · <strong>{window.assessed}</strong> assessed · {window.days} days · {window.responses - window.assessed} not assessed{window.needsReview ? ` (${window.needsReview} changed; needs review)` : ""}</p><p>{window.correct} correct · {window.partial} partial · {window.wrong} incorrect · {window.dontKnow} did not know · {window.uncertain} uncertain</p><p>{window.ai} provisional AI · {window.confirmed} learner-confirmed or corrected</p><p>Help: {window.independent} independent · {window.assisted} assisted · {window.helpUnknown} unknown</p><p>Recorded timer: {window.medianTimerMin === null ? "not enough data" : `median ${window.medianTimerMin} min (${window.timerCount} answers)`}. Elapsed question-to-answer: {window.medianElapsedMin === null ? "not enough data" : `median ${window.medianElapsedMin} min (${window.elapsedCount} answers; includes breaks)`}.</p>{range === "last30" && <p>{row.recallInsights.trend ? `Compared with the prior 30 days: correct ${row.recallInsights.trend.correctRateDelta >= 0 ? "+" : ""}${row.recallInsights.trend.correctRateDelta} pp, partial ${row.recallInsights.trend.partialRateDelta >= 0 ? "+" : ""}${row.recallInsights.trend.partialRateDelta} pp. Question difficulty may differ.` : "Not enough assessed answers across both periods to compare trends."}</p>}{window.staleExamples.map((item, index) => <a key={`${item.chatId}:${index}`} className="mr-2 underline" href={recallAnswerHref(item.chatId, item.sourceMessageId, item.toolCallId)}>Review changed answer {index + 1}</a>)}</div>
			}
			{showSummary && range === "last30" && row.recallCapacity && <RecallCapacityEvidence evidence={row.recallCapacity} />}
			{showGroups && <>
			<h4 className="font-medium">Approved topic groups</h4><p>Topics can overlap; each answer is counted once in subject totals. A correct answer in a topic is not automatically a mistake.</p>
			{(row.approvedRecallGroups?.[range] ?? []).length === 0 ? <p className="text-muted-foreground">No approved groups yet. Existing assessments remain available above.</p> : (row.approvedRecallGroups?.[range] ?? []).map((group) => <details key={group.id} open={Boolean(expandedGroups[group.id])} onToggle={(event) => { const open = event.currentTarget.open; setExpandedGroups((old) => old[group.id] === open ? old : { ...old, [group.id]: open }); }} className="rounded border p-2"><summary className="cursor-pointer"><ToolContentResponse>{group.name}</ToolContentResponse> · {group.count} answers {group.stale && "· source changed: review required"}</summary><ToolContentResponse>{group.reason}</ToolContentResponse><p>{group.distribution.correct} correct · {group.distribution.partial} partial · {group.distribution.wrong} incorrect · {group.distribution.dont_know} did not know · {group.distribution.uncertain} uncertain</p><p className="text-muted-foreground">{group.stale ? "This group is excluded from AI planning until reviewed again." : `Approved; suggested by ${group.model}.`}</p>{group.answers.map((answer, index) => <button type="button" key={answer.id} className="mr-2 underline" onClick={() => void openAnswer(answer.id, answer)}>Answer {index + 1}</button>)}</details>)}
			{!preview && <button type="button" disabled={busy} onClick={() => void loadPreview()} className="rounded border px-3 py-1.5">Review AI grouping input</button>}
			{preview && <div className="space-y-3 rounded border p-3"><p role="status">{progressStatus}</p><h4 className="font-medium">Preview before sending to AI</h4>{(preview.history?.length ?? 0) > 0 && <label className="block">Previous AI runs <select defaultValue="" onChange={(event) => { const run = preview.history?.find((entry) => entry.id === event.target.value); if (run) { setGroups((old) => [...old, ...run.groups.filter((group) => !old.some((existing) => existing.id === group.id))]); setNotice("Added the earlier proposal to your current review; existing selections were kept."); } }} className="rounded border bg-background p-1"><option value="">Choose a previous run</option>{preview.history?.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.model} · {run.groups.length} groups</option>)}</select></label>}<p>Subject: {preview.subject} · {preview.items.length} items will be sent ({preview.totalEligible} eligible, {preview.totalAnswers} subject-linked answers). No re-scan is performed. The request uses adaptive batches; previously proposed topic names and short reasons may be sent to connect later batches. Truncated or invalid batches may be split into extra model calls. Suggestions need review and model usage may incur a cost.</p>{preview.totalEligible > preview.limit && <div className="flex flex-wrap items-center gap-2"><span>Batch {Math.floor(preview.offset / preview.limit) + 1} / {Math.ceil(preview.totalEligible / preview.limit)}</span><button type="button" disabled={busy || preview.offset === 0} onClick={() => void loadPreview(Math.max(0, preview.offset - preview.limit))} className="rounded border px-2 py-1 disabled:opacity-40">Previous batch</button><button type="button" disabled={busy || preview.offset + preview.limit >= preview.totalEligible} onClick={() => void loadPreview(preview.offset + preview.limit)} className="rounded border px-2 py-1 disabled:opacity-40">Next batch</button><span>Save your edits before switching batches. Earlier AI runs remain available in history.</span></div>}<label>Model for this request <select value={role} onChange={(event) => setRole(event.target.value)} className="rounded border bg-background p-1"><option value="">Analyst (default)</option>{preview.availableRoles.map((item) => <option key={item.role} value={item.role}>{item.label} · {item.modelLabel}</option>)}</select></label><p>Selected model: {selectedModel}</p>{groupingCost !== null && groupingPrice ? <p>Illustrative estimate: ${groupingCost.toFixed(groupingCost < 0.01 ? 4 : 2)} at ${groupingPrice.input}/1M input and ${groupingPrice.output}/1M output tokens. Assumes about 3 characters per input token, 500 overhead per batch and 100 output tokens per answer; previous-group context, retries, reasoning and actual tokenization can cost more. Catalog prices may be outdated; this is not a spending limit.</p> : <p>No reliable per-token price is available for this model or subscription; actual billing depends on the provider.</p>}<details><summary className="cursor-pointer">Show all {preview.items.length} assessment items to be sent</summary><div className="max-h-64 overflow-auto">{preview.items.slice(previewPage * 10, (previewPage + 1) * 10).map((item) => <div key={item.id} className="border-b py-1"><p>{item.errorType || "No error type"} · {item.verdict} · {item.source === "user" ? "learner correction" : "provisional AI"}</p><ToolContentResponse>{presentMistakeAnalysis(item.topic || "No topic")}</ToolContentResponse>{item.feedback && <ToolContentResponse>{presentMistakeAnalysis(item.feedback)}</ToolContentResponse>}</div>)}</div><PageControls page={previewPage} totalPages={Math.max(1, Math.ceil(preview.items.length / 10))} onPageChange={setPreviewPage} prevLabel="Previous answers" nextLabel="Next answers" /></details><div className="flex flex-wrap gap-2"><button type="button" disabled={busy || preview.items.length < 2 || groupJob?.status === "running"} onClick={() => void groupAction("start_job")} className="rounded border px-3 py-1.5 disabled:opacity-40">Send preview and suggest groups</button><button type="button" onClick={() => setPreview(null)} className="rounded border px-3 py-1.5">Close</button></div>
				{groupJobs.length > 0 && <div className="space-y-2 rounded border p-2"><label>Grouping run <select value={groupJobId} onChange={(event) => setGroupJobId(event.target.value)} className="rounded border bg-background p-1">{groupJobs.map((job) => <option key={job.id} value={job.id}>{new Date(job.createdAt).toLocaleString()} · {job.model} · {job.completed.length}/{job.items.length}</option>)}</select></label>{groupJob && <><p>Status: {groupJob.status} · {groupJob.completed.length}/{groupJob.items.length} processed · {groupJob.skipped.length} skipped · {groupJob.usage.calls} recorded model turns · {groupJob.usage.input} input / {groupJob.usage.output} output tokens</p>{groupJob.error && <p role="alert">{groupJob.error}</p>}{groupJob.status === "running" ? <button type="button" onClick={() => void groupAction("pause_job")} disabled={busy} className="rounded border px-2 py-1">Pause grouping</button> : groupJob.completed.length + groupJob.skipped.length < groupJob.items.length ? <button type="button" onClick={() => void groupAction("resume_job")} disabled={busy} className="rounded border px-2 py-1">Resume remaining topics</button> : null}{groupJob.status !== "running" && groupJob.skipped.length > 0 && <button type="button" onClick={() => void groupAction("resume_job", true)} disabled={busy} className="rounded border px-2 py-1">Retry skipped topics</button>}<p>Suggestions are saved locally; topics may overlap. Cross-batch matching uses prior group summaries and may still need review.</p></>}</div>}
				{groups.length === 0 && preview.groups.length > 0 && <button type="button" disabled={busy} onClick={() => void save()} className="rounded border px-3 py-1.5">Remove all approved groups</button>}
				{groups.length > 0 && <><p>Review, rename, remove answers or split groups. Saving approved groups replaces this subject’s approved groups with only those checked below; it never changes FSRS or the plan.</p>{groups.slice(groupPage * 10, (groupPage + 1) * 10).map((group) => <div key={group.id} className="space-y-2 rounded border p-2"><button type="button" className="float-right underline" onClick={() => { setGroups((old) => old.filter((item) => item.id !== group.id)); setRemovedGroups((old) => ({ ...old, [group.id]: true })); setApproved((old) => ({ ...old, [group.id]: false })); }}>Remove group</button><label><input type="checkbox" checked={Boolean(approved[group.id])} onChange={(event) => setApproved((old) => ({ ...old, [group.id]: event.target.checked }))} /> Approve this group</label><label className="block">Name <input value={group.name} onChange={(event) => setGroups((old) => old.map((item) => item.id === group.id ? { ...item, name: event.target.value } : item))} className="w-full rounded border bg-background p-1" /></label><label className="block">Reason <textarea value={group.reason} onChange={(event) => setGroups((old) => old.map((item) => item.id === group.id ? { ...item, reason: event.target.value } : item))} className="w-full rounded border bg-background p-1" /></label><p>{group.members.length} answers · {group.model}</p>{group.members.map((member) => { const item = preview.allItems.find((value) => value.id === member.id); const changed = !item || item.fingerprint !== member.fingerprint; return <div key={member.id} className="flex flex-wrap items-center gap-2"><label><input type="checkbox" checked={Boolean(splitSelection[splitKey(group.id, member.id)])} onChange={(event) => setSplitSelection((old) => ({ ...old, [splitKey(group.id, member.id)]: event.target.checked }))} /> <span className="sr-only">Select answer</span></label><ToolContentResponse>{item?.topic || member.id}</ToolContentResponse><span> · {item?.verdict ?? "unavailable"}{changed && " · changed"}</span>{item && <button type="button" className="underline" onClick={() => void openAnswer(item.id, item)}>View answer here</button>}<button type="button" onClick={() => { setGroups((old) => old.map((value) => value.id === group.id ? { ...value, members: value.members.filter((m) => m.id !== member.id) } : value)); setApproved((old) => ({ ...old, [group.id]: false })); }} className="underline">Remove</button>{changed && item && item.verdict && !item.needsReview && <button type="button" onClick={() => { setGroups((old) => old.map((value) => value.id === group.id ? { ...value, members: value.members.map((m) => m.id === member.id ? { ...m, fingerprint: item.fingerprint } : m) } : value)); setApproved((old) => ({ ...old, [group.id]: false })); }} className="underline">Use current assessment</button>}</div>; })}<button type="button" onClick={() => split(group)} className="rounded border px-2 py-1">Split selected answers</button></div>)}<PageControls page={groupPage} totalPages={Math.max(1, Math.ceil(groups.length / 10))} onPageChange={setGroupPage} prevLabel="Previous groups" nextLabel="Next groups" /><div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void saveDraft()} className="rounded border px-3 py-1.5 disabled:opacity-40">Save draft</button><button type="button" disabled={busy || (!preview.groups.length && !groups.some((group) => approved[group.id]))} onClick={() => void save()} className="rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-40">Save approved groups</button></div></>}
			</div>}
			</>}
		</>}
		{error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
	</section>;
}

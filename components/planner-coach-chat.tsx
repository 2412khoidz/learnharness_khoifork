"use client";

import { useEffect, useRef, useState } from "react";
import type { CoachChatMessage } from "@/src/core";
import { HostMarkdown } from "@/components/host-markdown";
import { BrailleSpinner } from "@/components/braille-spinner";
import { cn } from "@/lib/utils";
import {
	CheckCircle2Icon,
	CornerDownLeftIcon,
	MessageSquareTextIcon,
	PaperclipIcon,
	RotateCcwIcon,
	SparklesIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";

type FocusArea = "schedule" | "lifestyle" | "general";
export interface CoachProposalPreview { id: string; summary: string; advice?: string; changes: Record<string, { before: unknown; after: unknown }> }

function ProposalValue({ value }: { value: unknown }) {
	if (value === null || value === undefined) return <span className="text-muted-foreground">None</span>;
	if (Array.isArray(value)) return value.length ? <ul className="space-y-1 border-l pl-2">{value.map((item, index) => <li key={index}><ProposalValue value={item} /></li>)}</ul> : <span className="text-muted-foreground">None</span>;
	if (typeof value === "object") return <dl className="space-y-1">{Object.entries(value).map(([key, item]) => <div key={key}><dt className="font-medium">{key.replace(/([a-z])([A-Z])/g, "$1 $2")}</dt><dd className="pl-2"><ProposalValue value={item} /></dd></div>)}</dl>;
	return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

const QUICK_PROMPTS: Record<FocusArea, string[]> = {
	schedule: [
		"Hôm nay dậy sớm 4h hơi mệt, làm nhẹ buổi sáng & thêm chợp mắt trưa 25p giúp tôi",
		"Ưu tiên ôn trọng tâm môn thi gần nhất hôm nay, tạm bớt môn chưa gấp",
		"Chỉnh giờ ăn tối sang 19:15 và ngủ lúc 22:45 tối nay",
	],
	lifestyle: [
		"Dạo này hay tỉnh sớm 4-5h sáng dù ngủ sớm, chỉnh lại sleep & wind-down giúp tôi",
		"Hay buồn ngủ (food coma) 8–9h tối & thỉnh thoảng lên cơn bứt rứt sau ngủ trưa/sáng sớm — tailor lịch giúp tôi",
		"Thêm tập thể thao vào hobby, đặt game tối đa 30p và tắt trước giờ ngủ 90p",
		"Dựa vào lực học & lịch sử log gần đây, tôi nên giữ Healthy hay Balanced?",
	],
	general: [
		"Xem giúp tôi đồ thị kiến thức + session gần đây, hôm nay nên tập trung mảng nào?",
		"Vì sao dạo này tôi hay sai câu lý thuyết, cách sửa cụ thể cho lịch hôm nay?",
		"Tối ưu lại toàn bộ nhịp học, ăn, ngủ hôm nay cho tôi theo năng lượng hiện tại",
	],
};

export function PlannerCoachChat({
	messages,
	lastUndoMessageId,
	focusArea,
	onChangeFocusArea,
	coachAvailable,
	coachModelLabel,
	availableRoles,
	selectedRole,
	onChangeRole,
	sending,
	draftText,
	onDraftChange,
	onSend,
	onUndo,
	onClear,
	onClose,
	embedded = false,
	proposal,
	onProposalDecision,
}: {
	messages: CoachChatMessage[];
	lastUndoMessageId?: string;
	focusArea: FocusArea;
	onChangeFocusArea: (area: FocusArea) => void;
	coachAvailable: boolean;
	coachModelLabel: string | null;
	availableRoles?: Array<{ role: string; label: string; modelLabel: string }>;
	selectedRole: string;
	onChangeRole: (role: string) => void;
	sending: boolean;
	draftText: string;
	onDraftChange: (text: string) => void;
	onSend: (text: string, focusArea?: FocusArea, files?: File[]) => Promise<boolean>;
	onUndo: (messageId: string) => Promise<void>;
	onClear: () => Promise<void>;
	onClose: () => void;
	embedded?: boolean;
	proposal?: CoachProposalPreview | null;
	onProposalDecision?: (apply: boolean) => Promise<void>;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const [files, setFiles] = useState<File[]>([]);
	const [reviewingId, setReviewingId] = useState<string | null>(null);
	const reviewingProposal = !!proposal && reviewingId === proposal.id;

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages.length, sending]);

	const handleSubmit = async () => {
		const trimmed = draftText.trim();
		if ((!trimmed && files.length === 0) || sending || !coachAvailable) return;
		if (await onSend(trimmed, focusArea, files)) {
			onDraftChange("");
			setFiles([]);
			if (fileRef.current) fileRef.current.value = "";
		}
	};

	return (
		<aside
			data-testid="planner-coach-drawer"
			className={cn("flex h-full min-h-0 w-full min-w-0 shrink-0 flex-col bg-card", embedded ? "border-0" : "border-l sm:w-[390px] xl:w-[430px]")}
		>
			{/* Header */}
			<div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<MessageSquareTextIcon className="size-4 shrink-0 text-primary" />
					<div className="min-w-0">
						<div className="truncate text-xs font-semibold text-foreground">AI Study & Habit Coach</div>
						<div className="truncate text-[10px] text-muted-foreground">
							Linked to Graph · Sessions · FSRS · Sleep Logs
						</div>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{messages.length > 0 && (
						<button
							type="button"
							disabled={sending}
							onClick={() => void onClear()}
							title="Clear conversation"
							className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
						>
							<Trash2Icon className="size-3.5" />
						</button>
					)}
					<button
						type="button"
						onClick={onClose}
						aria-label="Close Coach"
						title="Close Coach Side Chat"
						className="lh-no-drag rounded p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-3.5" />
					</button>
				</div>
			</div>

			{/* Focus Mode + Model Picker */}
			<div className="flex flex-wrap items-center justify-between gap-1.5 border-b bg-muted/25 px-3 py-1.5 text-[11px]">
				<div className="inline-flex rounded-md border bg-background p-0.5">
					{(
						[
							{ id: "schedule", label: "Schedule" },
							{ id: "lifestyle", label: "Sleep & Habits" },
							{ id: "general", label: "General" },
						] as const
					).map((f) => (
						<button
							key={f.id}
							type="button"
							onClick={() => onChangeFocusArea(f.id)}
							className={cn(
								"rounded px-1.5 py-0.5 text-[10px] transition-colors",
								focusArea === f.id ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{f.label}
						</button>
					))}
				</div>
				{availableRoles && availableRoles.length > 0 ? (
					<select
						value={selectedRole}
						onChange={(e) => onChangeRole(e.target.value)}
						className="max-w-[165px] truncate rounded border bg-background px-1.5 py-0.5 text-[10px]"
						title="Select model for Coach Chat"
					>
						<option value="">Auto ({coachModelLabel ?? "coach"})</option>
						{availableRoles.map((r) => (
							<option key={r.role} value={r.role}>
								{r.label}: {r.modelLabel}
							</option>
						))}
					</select>
				) : (
					<span className="truncate text-[10px] text-muted-foreground">
						{coachAvailable ? coachModelLabel : "No model key"}
					</span>
				)}
			</div>

			{/* Conversation Thread */}
			<div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3 text-xs">
				{messages.length === 0 ? (
					<div className="flex flex-col gap-2.5 text-muted-foreground">
						<div className="rounded-lg border border-dashed bg-muted/20 p-3 leading-relaxed">
							<p className="font-medium text-foreground">Ask Coach about your plan and habits</p>
							<p className="mt-1 text-[11px]">
								Coach receives planner data, graph concepts, learning summaries and selected session excerpts. The tabs change suggested prompts and focus, not permissions. Changes to Planner, existing graph concepts, session details and supported settings require review and can be undone. Graph creation/deletion and transcript rewriting are not supported here.
							</p>
						</div>
						<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							Suggested prompts ({focusArea === "schedule" ? "Schedule" : focusArea === "lifestyle" ? "Sleep & Habits" : "General"})
						</div>
						<div className="flex flex-col gap-1.5">
							{QUICK_PROMPTS[focusArea].map((prompt) => (
								<button
									key={prompt}
									type="button"
									disabled={sending || !coachAvailable}
									onClick={() => void onSend(prompt, focusArea)}
									className="rounded-lg border bg-background px-2.5 py-2 text-left text-[11px] leading-snug text-foreground transition-colors hover:bg-accent disabled:opacity-40"
								>
									&ldquo;{prompt}&rdquo;
								</button>
							))}
						</div>
					</div>
				) : (
					messages.map((msg) => (
						<div
							key={msg.id}
							data-testid={msg.role === "user" ? "planner-coach-user-msg" : "planner-coach-ai-msg"}
							className={cn(
								"flex flex-col gap-1.5",
								msg.role === "user" ? "ml-auto max-w-[85%] items-end" : "max-w-full items-start",
							)}
						>
							<div
								className={cn(
									"rounded-xl px-3 py-2 leading-relaxed",
									msg.role === "user"
										? "bg-muted font-medium text-foreground whitespace-pre-wrap"
										: "w-full border bg-background/80 text-foreground",
								)}
							>
								{msg.role === "user" ? (
									msg.text
								) : (
									<div className="[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
										<HostMarkdown text={msg.text} />
									</div>
								)}
							</div>
							{msg.attachments?.map((attachment) => (
								<a key={attachment.id} href={`/api/planner/coach/attachments/${encodeURIComponent(attachment.id)}`} download={attachment.name} className="max-w-full truncate rounded border bg-background px-2 py-1 text-[11px] text-primary underline">📎 {attachment.name}</a>
							))}

							{msg.appliedChange && (
								<div
									className={cn(
										"w-full rounded-lg border px-2.5 py-1.5 text-[11px]",
										msg.appliedChange.reverted
											? "border-border bg-muted/30 text-muted-foreground"
											: "border-success/40 bg-success/10 text-foreground",
									)}
								>
									<div className="flex items-center justify-between gap-2">
										<span className="inline-flex items-center gap-1 font-medium text-success">
											<CheckCircle2Icon className="size-3 shrink-0" />
											{msg.appliedChange.reverted ? "Reverted changes" : "Applied to Planner"}
										</span>
										{lastUndoMessageId === msg.id && !msg.appliedChange.reverted && (
											<button
												type="button"
												disabled={sending}
												onClick={() => void onUndo(msg.id)}
												className="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent disabled:opacity-40"
											>
												<RotateCcwIcon className="size-2.5" /> Undo
											</button>
										)}
									</div>
									<p className="mt-0.5 text-[11px]">{msg.appliedChange.summary}</p>
									{msg.appliedChange.patchLabels.length > 0 && (
										<div className="mt-1 flex flex-wrap gap-1">
											{msg.appliedChange.patchLabels.map((lbl) => (
												<span key={lbl} className="rounded border bg-background/80 px-1.5 py-0 text-[9px] text-muted-foreground">
													{lbl}
												</span>
											))}
										</div>
									)}
								</div>
							)}

							{msg.role === "assistant" && msg.modelLabel && (
								<span className="px-1 text-[9px] text-muted-foreground">
									<SparklesIcon className="mr-0.5 inline size-2.5 text-primary" /> {msg.modelLabel}
								</span>
							)}
						</div>
					))
				)}

				{proposal && <div className="rounded-lg border bg-muted/30 p-3 text-xs"><p className="font-medium">Changes awaiting review</p><p className="mt-1 text-muted-foreground">No changes have been applied. Review the proposed before and after values, then choose whether to apply them.</p><button type="button" className="mt-2 rounded border px-2 py-1" onClick={() => setReviewingId(reviewingProposal ? null : proposal.id)}>{reviewingProposal ? "Hide details" : "Review changes"}</button>{reviewingProposal && <>{proposal.advice && <div className="mt-2 rounded border bg-background p-2"><p className="font-medium">Coach advice</p><HostMarkdown text={proposal.advice} /></div>}<p className="mt-2 whitespace-pre-wrap">{proposal.summary}</p><div className="mt-2 max-h-72 space-y-3 overflow-auto rounded border bg-background p-2">{Object.entries(proposal.changes).map(([name, change]) => <details key={name}><summary className="cursor-pointer font-medium">{name.replace(/([a-z])([A-Z])/g, "$1 $2")}</summary><div className="mt-2 grid grid-cols-2 gap-2"><div><p className="mb-1 font-medium">Before</p><ProposalValue value={change.before} /></div><div><p className="mb-1 font-medium">After</p><ProposalValue value={change.after} /></div></div></details>)}</div><button type="button" disabled={sending} onClick={() => void onProposalDecision?.(true)} className="mt-2 rounded bg-primary px-3 py-1.5 text-primary-foreground">Confirm and apply</button></>}<button type="button" disabled={sending} onClick={() => void onProposalDecision?.(false)} className="ml-2 mt-2 rounded border px-3 py-1.5">Discard</button></div>}
				{sending && (
					<div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
						<BrailleSpinner /> Reading Graph, Sessions, FSRS & adjusting plan...
					</div>
				)}
			</div>

			{/* Composer Footer */}
			<div className="border-t bg-background p-3">
				{!coachAvailable ? (
					<div className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
						No Coach model configured. Open Settings → Models to set one up.
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						<input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.txt,.md,text/plain,text/markdown,application/pdf" className="sr-only" aria-label="Attach images or files" onChange={(event) => { setFiles(Array.from(event.target.files ?? [])); }} />
						{files.length > 0 && <div className="flex flex-wrap gap-1">{files.map((file, index) => <span key={`${file.name}-${index}`} className="inline-flex max-w-full items-center gap-1 rounded border px-2 py-1 text-[10px]"><span className="truncate">{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><XIcon className="size-3" /></button></span>)}</div>}
						<textarea
							ref={inputRef}
							rows={2}
							value={draftText}
							onChange={(e) => onDraftChange(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									void handleSubmit();
								}
							}}
							placeholder={
								focusArea === "lifestyle"
									? "Ask about sleep, meals, hobbies or gaming..."
									: "Tell Coach what you need help with..."
							}
							className="w-full resize-none rounded-lg border bg-card px-2.5 py-2 text-xs focus:border-primary focus:outline-none"
						/>
						<div className="flex items-center justify-between text-[10px] text-muted-foreground">
							<button type="button" className="inline-flex items-center gap-1 rounded border px-2 py-1 hover:bg-accent" onClick={() => fileRef.current?.click()} disabled={sending}><PaperclipIcon className="size-3" /> Images / files</button>
							<button
								type="button"
								disabled={sending || (!draftText.trim() && files.length === 0)}
								onClick={() => void handleSubmit()}
								data-testid="planner-coach-send-btn"
								className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
							>
								<CornerDownLeftIcon className="size-3" /> Send to Coach
							</button>
						</div>
					</div>
				)}
			</div>
		</aside>
	);
}

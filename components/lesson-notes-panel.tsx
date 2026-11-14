"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, DownloadIcon, StickyNoteIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const WIDTH_STORAGE_KEY = "lh:lesson-notes-width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 340;

export interface PendingNoteQuote {
	text: string;
	seq: number;
}

export function LessonNotesPanel({
	chatId,
	title,
	initialNotes = "",
	pendingQuote,
	onNotesChange,
	onClose,
}: {
	chatId: string;
	title: string;
	initialNotes?: string;
	pendingQuote: PendingNoteQuote | null;
	onNotesChange?: (notes: string) => void;
	onClose: () => void;
}) {
	const [notes, setNotes] = useState(initialNotes);
	const [width, setWidth] = useState(DEFAULT_WIDTH);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
	const [copied, setCopied] = useState(false);

	const notesRef = useRef(notes);
	notesRef.current = notes;
	const dirtyRef = useRef(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const lastQuoteSeqRef = useRef<number>(0);

	useEffect(() => {
		try {
			const stored = Number.parseInt(window.localStorage.getItem(WIDTH_STORAGE_KEY) ?? "", 10);
			if (Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH) {
				setWidth(stored);
			}
		} catch {
			// ignore storage access issues
		}
	}, []);

	const persistNotes = useCallback(async (text: string) => {
		if (!dirtyRef.current) return;
		dirtyRef.current = false;
		setSaveState("saving");
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ notes: text }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setSaveState("saved");
			onNotesChange?.(text);
		} catch {
			dirtyRef.current = true;
			setSaveState("error");
		}
	}, [chatId, onNotesChange]);

	const scheduleSave = useCallback((nextText: string) => {
		dirtyRef.current = true;
		setSaveState("saving");
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = undefined;
			void persistNotes(nextText);
		}, 500);
	}, [persistNotes]);

	useEffect(() => {
		let cancelled = false;
		// Sync once when opening in case mobile companion edited notes.
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}`, { cache: "no-store" });
				if (!res.ok || cancelled || dirtyRef.current) return;
				const data = (await res.json()) as { notes?: unknown };
				if (typeof data.notes === "string" && !dirtyRef.current && !cancelled) {
					setNotes(data.notes);
					onNotesChange?.(data.notes);
				}
			} catch {
				// non-fatal
			}
		})();
		return () => {
			cancelled = true;
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
				saveTimerRef.current = undefined;
			}
			if (dirtyRef.current) {
				void fetch(`/api/chats/${encodeURIComponent(chatId)}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ notes: notesRef.current }),
					keepalive: true,
				}).catch(() => {});
			}
		};
	}, [chatId, onNotesChange]);

	useEffect(() => {
		if (!pendingQuote || pendingQuote.seq === lastQuoteSeqRef.current) return;
		lastQuoteSeqRef.current = pendingQuote.seq;
		const clean = pendingQuote.text.trim();
		if (!clean) return;
		const block = clean
			.split(/\r?\n/)
			.map((line) => `> ${line}`)
			.join("\n");
		const current = notesRef.current.trimEnd();
		const next = current.length > 0 ? `${current}\n\n${block}\n` : `${block}\n`;
		setNotes(next);
		scheduleSave(next);
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) {
				el.focus();
				el.scrollTop = el.scrollHeight;
				el.setSelectionRange(next.length, next.length);
			}
		});
	}, [pendingQuote, scheduleSave]);

	const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = width;
		let latestWidth = startWidth;

		const onMove = (e: PointerEvent) => {
			const delta = startX - e.clientX;
			latestWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(startWidth + delta)));
			setWidth(latestWidth);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			try {
				window.localStorage.setItem(WIDTH_STORAGE_KEY, String(latestWidth));
			} catch {
				// ignore
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, [width]);

	const handleCopy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(notesRef.current);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable
		}
	}, []);

	const handleDownload = useCallback(() => {
		const slug = (title || "lesson-notes")
			.toLowerCase()
			.replace(/[^a-z0-9]+/gi, "-")
			.replace(/^-+|-+$/g, "") || "lesson-notes";
		const blob = new Blob([`# ${title || "Lesson Notes"}\n\n${notesRef.current}\n`], {
			type: "text/markdown;charset=utf-8",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${slug}-notes.md`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}, [title]);

	return (
		<aside
			aria-label="Lesson Notes"
			data-testid="lesson-notes-panel"
			style={{ width }}
			className="relative flex shrink-0 flex-col border-l border-border bg-background p-3"
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize lesson notes"
				onPointerDown={startResize}
				className="absolute inset-y-0 left-0 w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/40"
			/>
			<div className="mb-2 flex items-center justify-between gap-2">
				<div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-foreground">
					<StickyNoteIcon className="size-3.5 text-primary" aria-hidden />
					<span>Lesson Notes</span>
				</div>
				<div className="flex items-center gap-1">
					<span className="mr-1 text-[11px] text-muted-foreground" data-testid="lesson-notes-status">
						{saveState === "saving"
							? "Saving..."
							: saveState === "saved"
								? "Saved"
								: saveState === "error"
									? "Save failed"
									: "Markdown"}
					</span>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						title="Copy Markdown"
						aria-label="Copy notes"
						onClick={() => void handleCopy()}
					>
						{copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						title="Download .md"
						aria-label="Download notes"
						onClick={handleDownload}
					>
						<DownloadIcon className="size-3.5" />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						title="Close notes"
						aria-label="Close lesson notes"
						data-testid="close-lesson-notes"
						onClick={onClose}
					>
						<XIcon className="size-3.5" />
					</Button>
				</div>
			</div>
			<p className="mb-2 text-[11px] text-muted-foreground">
				Select any text in the lesson and click <span className="font-medium text-foreground">Note</span> to quote it here. Click any formula to copy its LaTeX.
			</p>
			<textarea
				ref={textareaRef}
				value={notes}
				onChange={(e) => {
					const val = e.target.value;
					setNotes(val);
					scheduleSave(val);
				}}
				onBlur={() => {
					if (dirtyRef.current) {
						if (saveTimerRef.current) {
							clearTimeout(saveTimerRef.current);
							saveTimerRef.current = undefined;
						}
						void persistNotes(notesRef.current);
					}
				}}
				placeholder="Write key formulas, intuitions, or exam reminders for this session..."
				data-testid="lesson-notes-textarea"
				className="min-h-0 flex-1 resize-none rounded-lg border border-border/80 bg-card/40 p-2.5 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-primary/60"
			/>
		</aside>
	);
}

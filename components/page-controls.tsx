"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Pagination bar with Previous/Next, direct page buttons, and a page-number jump input. */
export function PageControls({
	page,
	totalPages,
	onPageChange,
	prevLabel = "Previous",
	nextLabel = "Next",
	className,
}: {
	page: number;
	totalPages: number;
	onPageChange: (nextPage: number) => void;
	prevLabel?: string;
	nextLabel?: string;
	className?: string;
}) {
	const safeTotal = Math.max(1, totalPages);
	const safePage = Math.max(0, Math.min(page, safeTotal - 1));
	const [draft, setDraft] = useState(String(safePage + 1));
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setDraft(String(safePage + 1));
	}, [safePage]);

	const commitJump = () => {
		const raw = (inputRef.current?.value ?? draft).trim();
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed)) {
			setDraft(String(safePage + 1));
			return;
		}
		const target = Math.max(1, Math.min(safeTotal, parsed)) - 1;
		setDraft(String(target + 1));
		if (target !== safePage) onPageChange(target);
	};

	// Compact visible page list: first, last, and +-1 around current page.
	const pageTokens: Array<number | "ellipsis-left" | "ellipsis-right"> = [];
	if (safeTotal > 1) {
		const wanted = new Set<number>([0, safeTotal - 1, safePage - 1, safePage, safePage + 1].filter((n) => n >= 0 && n < safeTotal));
		const sorted = [...wanted].sort((a, b) => a - b);
		for (let i = 0; i < sorted.length; i++) {
			const current = sorted[i]!;
			const prev = i > 0 ? sorted[i - 1]! : -1;
			if (i > 0 && current - prev > 1) {
				pageTokens.push(current <= safePage ? "ellipsis-left" : "ellipsis-right");
			}
			pageTokens.push(current);
		}
	}

	return (
		<div className={cn("flex flex-wrap items-center gap-2 text-xs", className)}>
			<button
				type="button"
				disabled={safePage === 0}
				onClick={() => onPageChange(Math.max(0, safePage - 1))}
				className="rounded border px-2 py-1 disabled:opacity-40"
			>
				{prevLabel}
			</button>
			<span className="tabular-nums text-muted-foreground">
				{safePage + 1} / {safeTotal}
			</span>
			<button
				type="button"
				disabled={safePage + 1 >= safeTotal}
				onClick={() => onPageChange(Math.min(safeTotal - 1, safePage + 1))}
				className="rounded border px-2 py-1 disabled:opacity-40"
			>
				{nextLabel}
			</button>
			{safeTotal > 1 && (
				<div className="flex flex-wrap items-center gap-1">
					{pageTokens.map((token) =>
						typeof token === "string" ? (
							<span key={token} className="px-1 text-muted-foreground" aria-hidden="true">…</span>
						) : (
							<button
								key={token}
								type="button"
								aria-label={`Page ${token + 1}`}
								aria-current={token === safePage ? "page" : undefined}
								onClick={() => { if (token !== safePage) onPageChange(token); }}
								className={cn(
									"min-w-6 rounded border px-1.5 py-0.5 tabular-nums transition-colors",
									token === safePage ? "border-primary bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
								)}
							>
								{token + 1}
							</button>
						),
					)}
					<span className="ml-1 inline-flex items-center gap-1">
						<input
							ref={inputRef}
							type="text"
							inputMode="numeric"
							pattern="[0-9]*"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									commitJump();
								}
							}}
							aria-label="Jump to page"
							className="h-6 w-12 rounded border bg-background px-1.5 text-center tabular-nums outline-none focus:border-ring"
						/>
						<button
							type="button"
							onClick={commitJump}
							className="h-6 rounded border px-2 text-[11px] hover:bg-accent"
						>
							Go
						</button>
					</span>
				</div>
			)}
		</div>
	);
}

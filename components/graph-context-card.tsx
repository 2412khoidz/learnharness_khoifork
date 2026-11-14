"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { formatMathForPlainText, wrapBareMathForDisplay } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * The graph-context card (owner, 2026-10-04): the session's map pick —
 * message[0] of a session started with propositions picked from the
 * graph. Scaffolding, not a turn: minimal, muted, collapsed by default;
 * expand reveals the picked propositions (name — statement) and the
 * reasoning chains among them (premises → conclusion lines). The model
 * reads the same content through the marker's own text (toLlmMessages);
 * this card is the learner's face of it.
 */

/** The graph-context marker's details (native-messages.ts). */
export interface GraphContextData {
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
}

const CONTEXT_PROSE = "[--font-prose:var(--font-ui)] [--lh-prose-size:var(--text-xs)] [--lh-prose-leading:1.625] " +
	"[&_.katex]:[font-size:1.1em] [&_.katex-display]:my-1 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden";

export function GraphContextCard({ data, defaultOpen = false }: { data: GraphContextData; defaultOpen?: boolean }) {
	const [open, setOpen] = useState(defaultOpen);
	const { propositions = [], chains = [] } = data ?? {};
	const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	return (
		<div data-testid="graph-context-card" className="my-1">
			<button
				type="button"
				data-testid="graph-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Graph context</span>
				<span className="min-w-0 flex-1 truncate">
					{noun(propositions.length, "proposition", "propositions")}
					{chains.length > 0 ? ` · ${noun(chains.length, "chain", "chains")}` : ""}
				</span>
			</button>
			{open && (
				<div data-testid="graph-context-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{propositions.map((p) => (
						<div key={p.id} data-testid={`graph-context-prop-${p.id}`} className="space-y-0.5 leading-relaxed">
							<ToolContentResponse mode="static" className={`${CONTEXT_PROSE} font-medium text-foreground/85`}>
								{wrapBareMathForDisplay(p.name)}
							</ToolContentResponse>
							<ToolContentResponse mode="static" className={`${CONTEXT_PROSE} text-muted-foreground`}>
								{wrapBareMathForDisplay(p.statement)}
							</ToolContentResponse>
						</div>
					))}
					{chains.length > 0 && (
						<div className="pt-1">
							{chains.map((c, i) => (
								<div key={i} className="font-mono text-[11px] text-muted-foreground">
									{formatMathForPlainText(c)}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

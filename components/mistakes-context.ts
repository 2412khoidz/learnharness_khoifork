"use client";

import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { MistakeRecord, RecallScanResult } from "@/src/core";
import { useServerEvent } from "@/components/server-events";

const MISTAKE_UPSERT_EVENT = "lh:mistake-upserted";

/** Push an immediately saved MistakeRecord into active chat views without waiting
 *  for the debounced server-event refetch. */
export function notifyMistakeUpserted(mistake: MistakeRecord): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent<MistakeRecord>(MISTAKE_UPSERT_EVENT, { detail: mistake }));
}

/** The open session's recorded mistakes, keyed by `<chatId>:<toolCallId>` —
 *  the answer cards read their short "why" from here. Empty outside a chat
 *  (tests, previews), which renders no analysis. */
export const MistakesContext = createContext<ReadonlyMap<string, MistakeRecord>>(new Map());
export const RecallGradesContext = createContext<ReadonlyMap<string, RecallScanResult>>(new Map());

/** Recall grading may finish shortly after the tutor turn. */
export function useChatRecallGrades(chatId: string): ReadonlyMap<string, RecallScanResult> {
	const [grades, setGrades] = useState<ReadonlyMap<string, RecallScanResult>>(new Map());
	const load = useCallback(async () => {
		try {
			const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/recall-grades`, { cache: "no-store" });
			if (!response.ok) return;
			const body = await response.json() as { grades?: RecallScanResult[] };
			setGrades(new Map((body.grades ?? []).map((grade) => [grade.id, grade])));
		} catch { /* retain the last successful response */ }
	}, [chatId]);
	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), 5000);
		return () => clearInterval(timer);
	}, [load]);
	return grades;
}

/** Load a session's mistakes; refresh when they change (analysis landing). */
export function useChatMistakes(chatId: string): ReadonlyMap<string, MistakeRecord> {
	const [map, setMap] = useState<ReadonlyMap<string, MistakeRecord>>(new Map());
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/mistakes`, { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as { mistakes?: MistakeRecord[] };
			setMap(new Map((body.mistakes ?? []).map((m) => [m.id, m])));
		} catch {
			/* keep what we have */
		}
	}, [chatId]);
	useEffect(() => {
		void load();
		const onUpsert = (event: Event) => {
			const detail = (event as CustomEvent<MistakeRecord>).detail;
			if (!detail || detail.chatId !== chatId) return;
			setMap((prev) => {
				const next = new Map(prev);
				next.set(detail.id, detail);
				return next;
			});
		};
		window.addEventListener(MISTAKE_UPSERT_EVENT, onUpsert);
		return () => {
			clearTimeout(timer.current);
			clearTimeout(settleTimer.current);
			window.removeEventListener(MISTAKE_UPSERT_EVENT, onUpsert);
		};
	}, [load, chatId]);
	const schedule = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => void load(), 250);
	}, [load]);
	useServerEvent("mistakes-changed", schedule);
	// A turn settling is when new misses get recorded. The delayed read has
	// the same lifetime as the view: never fire after unmount or a chat swap.
	useServerEvent("turn-settled", (p) => {
		if (p.chatId !== chatId) return;
		clearTimeout(settleTimer.current);
		settleTimer.current = setTimeout(() => void load(), 800);
	});
	return map;
}

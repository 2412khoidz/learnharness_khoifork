"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Help = "independent" | "assisted" | "unknown";
type TimerState = { elapsed: number; runningSince: number | null; checkpoint: number; runId: string; interrupted: boolean; help: Help };
const elapsedAt = (timer: TimerState, now = Date.now()) => Math.max(0, timer.elapsed + (timer.runningSince === null ? 0 : Math.max(0, now - timer.runningSince)));
const MAX_TICK_GAP_MS = 5 * 60_000;

/** Browser-only timer. A new application run restores only the last checkpoint. */
export function useRecallTimer(key: string, enabled: boolean) {
	const [timer, setTimer] = useState<TimerState | null>(null);
	const ref = useRef<TimerState | null>(null);
	const [tick, setTick] = useState(0);
	const commit = useCallback((next: TimerState) => {
		ref.current = next; setTimer(next);
		try { localStorage.setItem(`lh.recall-timer.${key}`, JSON.stringify(next)); } catch { /* private browsing or storage limit */ }
	}, [key]);
	useEffect(() => {
		if (!enabled || ref.current) return;
		const now = Date.now(), runId = String(performance.timeOrigin);
		let old: TimerState | null = null;
		try { old = JSON.parse(localStorage.getItem(`lh.recall-timer.${key}`) ?? "null") as TimerState | null; } catch { /* start a fresh timer */ }
		if (old && Number.isFinite(old.elapsed) && Number.isFinite(old.checkpoint) && old.runId === runId && (old.runningSince === null || now - old.checkpoint <= MAX_TICK_GAP_MS)) commit(old);
		else if (old && Number.isFinite(old.elapsed) && Number.isFinite(old.checkpoint)) commit({ elapsed: old.elapsed + (old.runningSince === null ? 0 : Math.max(0, old.checkpoint - old.runningSince)), runningSince: null, checkpoint: now, runId, interrupted: true, help: old.help ?? "unknown" });
		else commit({ elapsed: 0, runningSince: now, checkpoint: now, runId, interrupted: false, help: "unknown" });
	}, [enabled, key, commit]);
	useEffect(() => {
		if (!timer || timer.runningSince === null) return;
		const interval = window.setInterval(() => {
			const current = ref.current; if (!current || current.runningSince === null) return;
			const now = Date.now();
			if (now - current.checkpoint > MAX_TICK_GAP_MS) {
				commit({ ...current, elapsed: current.elapsed + Math.max(0, current.checkpoint - current.runningSince), runningSince: null, checkpoint: now, interrupted: true });
				return;
			}
			const next = { ...current, checkpoint: now }; ref.current = next;
			try { localStorage.setItem(`lh.recall-timer.${key}`, JSON.stringify(next)); } catch { /* no persistent storage */ }
			setTick((value) => value + 1);
		}, 1000);
		return () => window.clearInterval(interval);
	}, [timer?.runningSince !== null, key, commit]);
	void tick;
	const pause = () => { const current = ref.current; if (!current) return; const now = Date.now(); commit({ ...current, elapsed: elapsedAt(current, now), runningSince: null, checkpoint: now }); };
	const resume = () => { const current = ref.current; if (!current) return; const now = Date.now(); commit({ ...current, runningSince: now, checkpoint: now, interrupted: false }); };
	const adjust = (minutes: number) => { const current = ref.current; if (!current || !Number.isFinite(minutes) || minutes < 0 || minutes > 10080) return; commit({ ...current, elapsed: Math.round(minutes * 60000), runningSince: null, checkpoint: Date.now(), interrupted: false }); };
	const setHelp = (help: Help) => { const current = ref.current; if (current) commit({ ...current, help }); };
	const snapshot = () => { const current = ref.current; return current ? { recallTiming: { timerMs: Math.min(7 * 86400_000, elapsedAt(current)), ...(current.interrupted ? { interrupted: true } : {}) }, recallHelp: current.help } : {}; };
	return { timer, elapsedMs: timer ? elapsedAt(timer) : 0, pause, resume, adjust, setHelp, snapshot };
}

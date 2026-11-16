"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRightIcon, CalendarClockIcon, CheckIcon, ClockIcon, XIcon } from "lucide-react";
import {
	resolveActiveBlockStatus,
	type DailyHabitLog,
	type DailyStudyPlan,
} from "@/src/core";
import { useServerEvent } from "@/components/server-events";

interface PlannerLightPayload {
	config?: {
		milestones?: unknown[];
		fixedEvents?: unknown[];
		logs?: Record<string, DailyHabitLog>;
	};
	plan?: DailyStudyPlan;
}

/**
 * Unobtrusive bottom-right floating status/switch pill:
 * - Invisible when user hasn't configured milestones/blocks or when already on /planner.
 * - Surfaces a soft-strict subject switch prompt when a study block ends (never locks out).
 */
export function PlannerSwitchPill() {
	const pathname = usePathname();
	const router = useRouter();
	const [payload, setPayload] = useState<PlannerLightPayload | null>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [snoozeUntilMs, setSnoozeUntilMs] = useState(0);
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);
	const [idleReturnMin, setIdleReturnMin] = useState<number | null>(null);
	const lastActivityRef = useRef<number>(Date.now());
	const isStudyingRef = useRef(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/planner", { cache: "no-store" });
			if (!res.ok) return;
			const data = (await res.json()) as PlannerLightPayload;
			setPayload(data);
		} catch {
			// Best-effort ambient status
		}
	}, []);

	useEffect(() => {
		void load();
		const tick = setInterval(() => setNowMs(Date.now()), 60_000);
		return () => clearInterval(tick);
	}, [load]);

	useEffect(() => {
		const IDLE_THRESHOLD_MS = 8 * 60_000;
		const onActivity = () => {
			if (document.visibilityState === "hidden") return;
			const now = Date.now();
			const gap = now - lastActivityRef.current;
			lastActivityRef.current = now;
			if (isStudyingRef.current && gap >= IDLE_THRESHOLD_MS) {
				setIdleReturnMin(Math.min(180, Math.round(gap / 60_000)));
			}
		};
		window.addEventListener("mousemove", onActivity, { passive: true });
		window.addEventListener("keydown", onActivity, { passive: true });
		document.addEventListener("visibilitychange", onActivity);
		return () => {
			window.removeEventListener("mousemove", onActivity);
			window.removeEventListener("keydown", onActivity);
			document.removeEventListener("visibilitychange", onActivity);
		};
	}, []);

	useServerEvent("planner-changed", load);

	if (pathname?.startsWith("/planner") || !payload?.plan) {
		isStudyingRef.current = false;
		return null;
	}
	const hasConfiguredWork =
		(payload.config?.milestones?.length ?? 0) > 0 ||
		(payload.config?.fixedEvents?.length ?? 0) > 0;
	if (!hasConfiguredWork) {
		isStudyingRef.current = false;
		return null;
	}

	const plan = payload.plan;
	const log = payload.config?.logs?.[plan.date];
	const status = resolveActiveBlockStatus(plan, log, nowMs);
	isStudyingRef.current = status.currentBlock?.type === "study";

	if (idleReturnMin !== null) {
		const logIdleBreak = async () => {
			await fetch("/api/planner/checkin", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ date: plan.date, hobbyDone: true }),
			}).catch(() => {});
			setIdleReturnMin(null);
			void load();
		};
		return (
			<div
				data-testid="planner-idle-pill"
				className="fixed bottom-4 right-4 z-30 hidden max-w-md items-center gap-2 rounded-full border border-primary/30 bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur sm:flex"
			>
				<ClockIcon className="size-3.5 shrink-0 text-primary" />
				<span className="truncate text-foreground">
					Idle {idleReturnMin}m — count as break/hobby?
				</span>
				<button
					type="button"
					onClick={() => void logIdleBreak()}
					className="rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					Log Break
				</button>
				<button
					type="button"
					onClick={() => setIdleReturnMin(null)}
					className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					Dismiss
				</button>
			</div>
		);
	}

	if (nowMs < snoozeUntilMs) return null;

	const activeKey = status.shouldPromptSwitch
		? `switch_${status.recentlyEndedBlock?.id ?? status.currentBlock?.id ?? ""}_${status.nextStudyBlock?.id ?? ""}`
		: status.preSwitchWarning && status.nextStudyBlock
			? `warn_${status.currentBlock?.id ?? ""}_${status.nextStudyBlock.id}`
			: status.currentBlock?.type === "study"
				? `active_${status.currentBlock.id}`
				: null;

	if (!activeKey || dismissedKey === activeKey) return null;

	const markEndedAndSwitch = async () => {
		if (status.recentlyEndedBlock) {
			await fetch("/api/planner/checkin", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ date: plan.date, toggleBlockId: status.recentlyEndedBlock.id }),
			}).catch(() => {});
		}
		if (status.nextStudyBlock) {
			const topic = encodeURIComponent(status.nextStudyBlock.actionTopic || status.nextStudyBlock.subject || status.nextStudyBlock.title);
			router.push(`/chat/new?topic=${topic}`);
		} else {
			router.push("/planner");
		}
		setDismissedKey(activeKey);
	};

	const markCurrentDone = async () => {
		if (!status.currentBlock) return;
		await fetch("/api/planner/checkin", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ date: plan.date, toggleBlockId: status.currentBlock.id }),
		}).catch(() => {});
		void load();
	};

	if (status.shouldPromptSwitch && status.nextStudyBlock) {
		return (
			<div
				data-testid="planner-switch-pill"
				className="fixed bottom-4 right-4 z-30 hidden max-w-md items-center gap-2 rounded-full border border-primary/30 bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur sm:flex"
			>
				<ClockIcon className="size-3.5 shrink-0 text-primary" />
				<span className="truncate text-foreground">
					Switch to <strong>{status.nextStudyBlock.subject || status.nextStudyBlock.title}</strong>
				</span>
				<button
					type="button"
					onClick={() => void markEndedAndSwitch()}
					className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					Switch <ArrowRightIcon className="size-3" />
				</button>
				<button
					type="button"
					onClick={() => setSnoozeUntilMs(Date.now() + 5 * 60_000)}
					className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
					title="Extend current focus by 5 minutes"
				>
					+5m
				</button>
				<button
					type="button"
					onClick={() => setSnoozeUntilMs(Date.now() + 15 * 60_000)}
					className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
					title="Extend current focus by 15 minutes"
				>
					+15m
				</button>
				<button
					type="button"
					aria-label="Dismiss switch reminder"
					onClick={() => setDismissedKey(activeKey)}
					className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3" />
				</button>
			</div>
		);
	}

	if (status.preSwitchWarning && status.nextStudyBlock && status.currentBlock) {
		return (
			<div
				data-testid="planner-warn-pill"
				className="fixed bottom-4 right-4 z-30 hidden max-w-lg items-center gap-2 rounded-full border border-warning/50 bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur sm:flex"
			>
				<ClockIcon className="size-3.5 shrink-0 text-warning" />
				<span className="truncate text-foreground">
					{status.minutesRemaining}m left in <strong>{status.currentBlock.subject || status.currentBlock.title}</strong> — wrap up step (Next: {status.nextStudyBlock.subject || status.nextStudyBlock.title})
				</span>
				<button
					type="button"
					onClick={() => setSnoozeUntilMs(Date.now() + 5 * 60_000)}
					className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
					title="Postpone switch warning by 5 minutes"
				>
					+5m
				</button>
				<button
					type="button"
					onClick={() => void markEndedAndSwitch()}
					className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
				>
					Switch <ArrowRightIcon className="size-3" />
				</button>
			</div>
		);
	}

	if (status.currentBlock?.type === "study") {
		return (
			<div
				data-testid="planner-active-pill"
				className="fixed bottom-4 right-4 z-30 hidden max-w-sm items-center gap-2 rounded-full border bg-card/90 px-3 py-1 text-xs shadow-md backdrop-blur sm:flex"
			>
				<CalendarClockIcon className="size-3 shrink-0 text-primary" />
				<button
					type="button"
					onClick={() => router.push("/planner")}
					className="truncate text-left text-muted-foreground hover:text-foreground"
					title="Open Study Planner"
				>
					<span className="font-medium text-foreground">{status.currentBlock.subject || status.currentBlock.title}</span>
					{" · "}
					{status.minutesRemaining}m left
				</button>
				<button
					type="button"
					onClick={() => void markCurrentDone()}
					className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent"
					title="Mark block completed"
				>
					<CheckIcon className="size-3" /> Done
				</button>
				<button
					type="button"
					aria-label="Hide planner pill"
					onClick={() => setDismissedKey(activeKey)}
					className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3" />
				</button>
			</div>
		);
	}

	return null;
}

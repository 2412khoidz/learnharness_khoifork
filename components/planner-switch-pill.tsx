"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowRightIcon, CalendarClockIcon, CheckIcon, ClockIcon, GripVerticalIcon, MinusIcon, XIcon } from "lucide-react";
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
	const [minimized, setMinimized] = useState(false);
	const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
	const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

	useEffect(() => {
		try {
			if (window.localStorage.getItem("lh:planner-pill-min") === "1") setMinimized(true);
			const rawPos = window.localStorage.getItem("lh:planner-pill-pos");
			if (rawPos) {
				const parsed = JSON.parse(rawPos) as { x?: unknown; y?: unknown };
				if (typeof parsed.x === "number" && Number.isFinite(parsed.x) && typeof parsed.y === "number" && Number.isFinite(parsed.y)) {
					setPos({ x: parsed.x, y: parsed.y });
				}
			}
		} catch {
			// Ignore localStorage unavailability.
		}
	}, []);

	const toggleMinimized = useCallback(() => {
		setMinimized((prev) => {
			const next = !prev;
			try {
				window.localStorage.setItem("lh:planner-pill-min", next ? "1" : "0");
			} catch {
				// Ignore localStorage unavailability.
			}
			return next;
		});
	}, []);

	const resetPos = useCallback(() => {
		setPos({ x: 0, y: 0 });
		try {
			window.localStorage.removeItem("lh:planner-pill-pos");
		} catch {
			// Ignore localStorage unavailability.
		}
	}, []);

	const handleDragDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = {
			startX: event.clientX,
			startY: event.clientY,
			origX: pos.x,
			origY: pos.y,
		};
	}, [pos]);

	const handleDragMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		let nextX = drag.origX + (event.clientX - drag.startX);
		let nextY = drag.origY + (event.clientY - drag.startY);
		if (typeof window !== "undefined") {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			nextX = Math.max(-(vw - 100), Math.min(24, nextX));
			nextY = Math.max(-(vh - 96), Math.min(48, nextY));
		}
		setPos({ x: nextX, y: nextY });
	}, []);

	const handleDragUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
		if (!dragRef.current) return;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		dragRef.current = null;
		setPos((latest) => {
			try {
				window.localStorage.setItem("lh:planner-pill-pos", JSON.stringify(latest));
			} catch {
				// Ignore localStorage unavailability.
			}
			return latest;
		});
	}, []);

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

	useServerEvent("planner-changed", load);

	if (pathname?.startsWith("/planner") || !payload?.plan) return null;
	const hasConfiguredWork =
		(payload.config?.milestones?.length ?? 0) > 0 ||
		(payload.config?.fixedEvents?.length ?? 0) > 0;
	if (!hasConfiguredWork) return null;

	if (nowMs < snoozeUntilMs) return null;

	const plan = payload.plan;
	const log = payload.config?.logs?.[plan.date];
	const status = resolveActiveBlockStatus(plan, log, nowMs);

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

	const dragStyle = pos.x !== 0 || pos.y !== 0 ? { transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` } : undefined;
	const gripButton = (
		<button
			type="button"
			data-testid="planner-pill-drag"
			onPointerDown={handleDragDown}
			onPointerMove={handleDragMove}
			onPointerUp={handleDragUp}
			onPointerCancel={handleDragUp}
			onDoubleClick={resetPos}
			className="inline-flex cursor-grab touch-none items-center rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing"
			title="Drag to move · Double-click to reset"
			aria-label="Drag planner pill"
		>
			<GripVerticalIcon className="size-3" />
		</button>
	);
	const minimizeButton = (
		<button
			type="button"
			data-testid="planner-pill-minimize"
			aria-label="Minimize planner pill"
			onClick={toggleMinimized}
			className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
			title="Minimize bar"
		>
			<MinusIcon className="size-3" />
		</button>
	);

	if (minimized) {
		const isSwitch = Boolean(status.shouldPromptSwitch && status.nextStudyBlock);
		const isWarn = Boolean(!isSwitch && status.preSwitchWarning && status.nextStudyBlock && status.currentBlock);
		const compactTestId = isSwitch ? "planner-switch-pill" : isWarn ? "planner-warn-pill" : "planner-active-pill";
		const compactLabel = isSwitch
			? "Switch"
			: `${status.minutesRemaining}m`;
		return (
			<div
				data-testid={compactTestId}
				style={dragStyle}
				className={`lh-no-drag fixed bottom-16 right-4 z-30 hidden items-center gap-1 rounded-full border bg-card/90 px-2 py-1 text-xs shadow-md backdrop-blur sm:flex ${
					isSwitch ? "border-primary/40" : isWarn ? "border-warning/50" : ""
				}`}
			>
				{gripButton}
				<button
					type="button"
					data-testid="planner-pill-expand"
					onClick={toggleMinimized}
					className="inline-flex cursor-pointer items-center gap-1 rounded-full px-1 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent"
					title="Expand active study block bar"
				>
					{isSwitch ? (
						<ClockIcon className="size-3 text-primary" />
					) : isWarn ? (
						<ClockIcon className="size-3 text-warning" />
					) : (
						<CalendarClockIcon className="size-3 text-primary" />
					)}
					<span className="tabular-nums">{compactLabel}</span>
				</button>
			</div>
		);
	}

	if (status.shouldPromptSwitch && status.nextStudyBlock) {
		return (
			<div
				data-testid="planner-switch-pill"
				style={dragStyle}
				className="lh-no-drag fixed bottom-16 right-4 z-30 hidden max-w-md items-center gap-1.5 rounded-full border border-primary/30 bg-card/95 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur sm:flex"
			>
				{gripButton}
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
				{minimizeButton}
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
				style={dragStyle}
				className="lh-no-drag fixed bottom-16 right-4 z-30 hidden max-w-lg items-center gap-1.5 rounded-full border border-warning/50 bg-card/95 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur sm:flex"
			>
				{gripButton}
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
				{minimizeButton}
			</div>
		);
	}

	if (status.currentBlock?.type === "study") {
		return (
			<div
				data-testid="planner-active-pill"
				style={dragStyle}
				className="lh-no-drag fixed bottom-16 right-4 z-30 hidden max-w-sm items-center gap-1.5 rounded-full border bg-card/90 px-2.5 py-1 text-xs shadow-md backdrop-blur sm:flex"
			>
				{gripButton}
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
				{minimizeButton}
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

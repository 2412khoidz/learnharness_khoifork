"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { CheckCircle2Icon, CopyIcon, PowerIcon, RefreshCwIcon, SmartphoneIcon, XIcon } from "lucide-react";
import {
	buildPhoneTunnelUploadUrl,
	buildPhoneUploadUrl,
	encodeQrMatrix,
	qrSvgPath,
	type AttachmentUploadResult,
	type PhoneTunnelStatus,
	type PhoneUploadEntry,
	type PhoneUploadPollResponse,
	type PhoneUploadSessionInfo,
} from "@/src/core";
import { cn } from "@/lib/utils";
import { HostDialog } from "@/components/host-dialog";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";

const POLL_INTERVAL_MS = 700;
const CURSOR_STORAGE_PREFIX = "lh:phone-cursor:";
const ACTIVE_SESSION_STORAGE_KEY = "lh:phone-active-session";

interface PhoneCoordinator {
	activeSessionId: string | null;
	consumedBySession: Map<string, number>;
	historyBySession: Map<string, PhoneUploadEntry[]>;
	inFlightSessions: Set<string>;
	backfilledSessions: Set<string>;
	listeners: Set<() => void>;
}

const coordinator: PhoneCoordinator = {
	activeSessionId: null,
	consumedBySession: new Map(),
	historyBySession: new Map(),
	inFlightSessions: new Set(),
	backfilledSessions: new Set(),
	listeners: new Set(),
};

function notifyCoordinator(): void {
	for (const listener of coordinator.listeners) listener();
}

function readStorage(key: string): string | null {
	try {
		return typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) : null;
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string | null): void {
	try {
		if (typeof sessionStorage === "undefined") return;
		if (value === null) sessionStorage.removeItem(key);
		else sessionStorage.setItem(key, value);
	} catch {
		// Ignore unavailable sessionStorage in tests or restricted contexts.
	}
}

function getActiveCoordinatorSession(): string | null {
	if (coordinator.activeSessionId) return coordinator.activeSessionId;
	const stored = readStorage(ACTIVE_SESSION_STORAGE_KEY);
	if (stored) coordinator.activeSessionId = stored;
	return coordinator.activeSessionId;
}

function setActiveCoordinatorSession(sessionId: string | null): void {
	if (coordinator.activeSessionId === sessionId) return;
	coordinator.activeSessionId = sessionId;
	writeStorage(ACTIVE_SESSION_STORAGE_KEY, sessionId);
	notifyCoordinator();
}

function getConsumedCursor(sessionId: string): number {
	const cached = coordinator.consumedBySession.get(sessionId);
	if (cached !== undefined) return cached;
	const raw = readStorage(`${CURSOR_STORAGE_PREFIX}${sessionId}`);
	const parsed = raw ? Number.parseInt(raw, 10) : 0;
	const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	coordinator.consumedBySession.set(sessionId, value);
	return value;
}

function setConsumedCursor(sessionId: string, nextIndex: number): void {
	const normalized = Number.isFinite(nextIndex) && nextIndex > 0 ? Math.floor(nextIndex) : 0;
	coordinator.consumedBySession.set(sessionId, normalized);
	writeStorage(`${CURSOR_STORAGE_PREFIX}${sessionId}`, String(normalized));
}

function recordSessionUploads(sessionId: string, entries: readonly PhoneUploadEntry[]): PhoneUploadEntry[] {
	if (entries.length === 0) return coordinator.historyBySession.get(sessionId) ?? [];
	const existing = coordinator.historyBySession.get(sessionId) ?? [];
	const byIndex = new Map<number, PhoneUploadEntry>();
	for (const entry of existing) byIndex.set(entry.index, entry);
	for (const entry of entries) byIndex.set(entry.index, entry);
	const merged = [...byIndex.values()].sort((a, b) => a.index - b.index);
	coordinator.historyBySession.set(sessionId, merged);
	notifyCoordinator();
	return merged;
}

function clearCoordinatorSession(sessionId: string | null | undefined): void {
	if (!sessionId) return;
	coordinator.consumedBySession.delete(sessionId);
	coordinator.historyBySession.delete(sessionId);
	coordinator.inFlightSessions.delete(sessionId);
	coordinator.backfilledSessions.delete(sessionId);
	writeStorage(`${CURSOR_STORAGE_PREFIX}${sessionId}`, null);
	if (getActiveCoordinatorSession() === sessionId) setActiveCoordinatorSession(null);
	else notifyCoordinator();
}

/** Test-only reset for isolated unit runs in Node. */
export function resetPhoneUploadCoordinatorForTests(): void {
	for (const sessionId of [...coordinator.consumedBySession.keys()]) {
		writeStorage(`${CURSOR_STORAGE_PREFIX}${sessionId}`, null);
	}
	coordinator.activeSessionId = null;
	coordinator.consumedBySession.clear();
	coordinator.historyBySession.clear();
	coordinator.inFlightSessions.clear();
	coordinator.backfilledSessions.clear();
	writeStorage(ACTIVE_SESSION_STORAGE_KEY, null);
	notifyCoordinator();
}

function insertPathsIntoEditor(editorRef: RefObject<HTMLDivElement | null>, paths: string[]): void {
	if (paths.length === 0) return;
	editorRef.current?.dispatchEvent(
		new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: { paths, focus: false } }),
	);
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function stopSessionRequest(sessionId: string): void {
	if (!sessionId || typeof fetch !== "function") return;
	void fetch(`/api/attachments/phone?sessionId=${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
		keepalive: true,
	}).catch(() => {});
}

export function PhoneUploadButton({
	editorRef,
	compact = false,
	disabled = false,
}: {
	editorRef: RefObject<HTMLDivElement | null>;
	compact?: boolean;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [bgSessionId, setBgSessionId] = useState<string | null>(() => getActiveCoordinatorSession());
	const prewarmRequestedRef = useRef(false);

	useEffect(() => {
		const sync = () => {
			setBgSessionId(getActiveCoordinatorSession());
		};
		sync();
		coordinator.listeners.add(sync);
		return () => {
			coordinator.listeners.delete(sync);
		};
	}, []);

	useEffect(() => {
		if (disabled || prewarmRequestedRef.current || typeof fetch !== "function") return;
		if (typeof window === "undefined" || typeof window.ResizeObserver !== "function") return;
		prewarmRequestedRef.current = true;
		void fetch("/api/attachments/phone", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ warm: true }),
		}).catch(() => {});
	}, [disabled]);

	// Keep polling received camera uploads quietly in the background across dock transitions.
	useEffect(() => {
		if (open || !bgSessionId || disabled || typeof fetch !== "function") return;
		let cancelled = false;
		const sessionId = bgSessionId;
		const pollBackground = async () => {
			if (cancelled || coordinator.inFlightSessions.has(sessionId)) return;
			coordinator.inFlightSessions.add(sessionId);
			try {
				const cursor = getConsumedCursor(sessionId);
				const res = await fetch(
					`/api/attachments/phone?sessionId=${encodeURIComponent(sessionId)}&since=${cursor}`,
				);
				if (!res.ok || cancelled) return;
				const data = (await res.json()) as PhoneUploadPollResponse;
				if (cancelled) return;
				if (!data.active) {
					clearCoordinatorSession(sessionId);
					return;
				}
				const latestCursor = getConsumedCursor(sessionId);
				const freshUploads = data.uploads.filter((item) => item.index >= latestCursor);
				if (data.uploads.length > 0) recordSessionUploads(sessionId, data.uploads);
				const nextCursor = Math.max(latestCursor, data.nextIndex, ...freshUploads.map((item) => item.index + 1));
				if (nextCursor > latestCursor) setConsumedCursor(sessionId, nextCursor);
				if (freshUploads.length > 0) {
					insertPathsIntoEditor(editorRef, freshUploads.map((item: AttachmentUploadResult) => item.path));
				}
			} catch {
				// Ignore transient polling hiccups while companion server runs.
			} finally {
				coordinator.inFlightSessions.delete(sessionId);
			}
		};
		const timer = setInterval(() => { void pollBackground(); }, 1200);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [open, bgSessionId, disabled, editorRef]);

	return (
		<>
			<Hint label={bgSessionId ? "Phone Companion connected (runs in background)" : "Upload photos from phone"}>
				<button
					type="button"
					data-testid="phone-upload"
					aria-label="Upload photos from phone"
					aria-haspopup="dialog"
					aria-expanded={open}
					disabled={disabled}
					onClick={() => { if (!disabled) setOpen(true); }}
					className={cn(
						"relative flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
						compact ? "size-8 rounded-md" : "size-10 rounded-[10px]",
					)}
				>
					<SmartphoneIcon className="size-4" aria-hidden />
					{bgSessionId && !disabled && (
						<span
							data-testid="phone-connected-dot"
							className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-success ring-1 ring-background"
							aria-hidden
						/>
					)}
				</button>
			</Hint>
			<HostDialog
				open={open}
				onClose={() => {
					setOpen(false);
					return "closed";
				}}
				aria-label="Upload photos from phone"
				frame={
					<div
						data-testid="phone-upload-dialog"
						className="w-[min(420px,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-xl outline-none"
					/>
				}
				backdropProps={{
					className: "fixed inset-0 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]",
				}}
			>
				{open && (
					<PhoneUploadDialogBody
						editorRef={editorRef}
						onClose={() => setOpen(false)}
					/>
				)}
			</HostDialog>
		</>
	);
}

function PhoneUploadDialogBody({
	editorRef,
	onClose,
}: {
	editorRef: RefObject<HTMLDivElement | null>;
	onClose: () => void;
}) {
	const [session, setSession] = useState<PhoneUploadSessionInfo | null>(null);
	const [selectedAddress, setSelectedAddress] = useState("");
	const [connectionMode, setConnectionMode] = useState<"tunnel" | "lan">("tunnel");
	const [tunnelStatus, setTunnelStatus] = useState<PhoneTunnelStatus>("off");
	const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
	const [tunnelError, setTunnelError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [received, setReceived] = useState<PhoneUploadEntry[]>([]);
	const [sessionHistory, setSessionHistory] = useState<PhoneUploadEntry[]>([]);
	const [selectedEarlier, setSelectedEarlier] = useState<Set<number>>(new Set());
	const [manuallyInserted, setManuallyInserted] = useState<Set<number>>(new Set());
	const [copied, setCopied] = useState(false);
	const [reloadNonce, setReloadNonce] = useState(0);

	const sessionIdRef = useRef<string | null>(null);
	const receivedCountRef = useRef(0);
	const refreshTunnelRef = useRef(false);
	const forceNewRef = useRef(false);

	useEffect(() => {
		const syncHistory = () => {
			if (!sessionIdRef.current) return;
			setSessionHistory(coordinator.historyBySession.get(sessionIdRef.current) ?? []);
		};
		coordinator.listeners.add(syncHistory);
		return () => {
			coordinator.listeners.delete(syncHistory);
		};
	}, []);

	const startSession = useCallback(async (signal: AbortSignal) => {
		const refreshTunnel = refreshTunnelRef.current;
		const forceNew = forceNewRef.current;
		refreshTunnelRef.current = false;
		forceNewRef.current = false;
		setLoading(true);
		setError("");
		setReceived([]);
		setSelectedEarlier(new Set());
		setManuallyInserted(new Set());
		setTunnelStatus("off");
		setTunnelUrl(null);
		setTunnelError(null);
		receivedCountRef.current = 0;
		const priorSessionId = sessionIdRef.current ?? getActiveCoordinatorSession();

		try {
			const bodyPayload: { refreshTunnel?: boolean; forceNew?: boolean } = {};
			if (refreshTunnel) bodyPayload.refreshTunnel = true;
			if (forceNew) bodyPayload.forceNew = true;
			const hasBody = Object.keys(bodyPayload).length > 0;
			const response = await fetch(
				"/api/attachments/phone",
				hasBody
					? {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(bodyPayload),
						signal,
					}
					: { method: "POST", signal },
			);
			const payload = await response.json().catch(() => ({})) as Partial<PhoneUploadSessionInfo> & { error?: string };
			if (!response.ok || !payload.sessionId || !payload.token || !payload.port) {
				throw new Error(payload.error || "Could not start phone upload server.");
			}
			if (signal.aborted) return;
			const info = payload as PhoneUploadSessionInfo;
			if (forceNew) {
				clearCoordinatorSession(priorSessionId);
				clearCoordinatorSession(info.sessionId);
			}
			const nextLan = info.defaultAddress ?? info.addresses[0]?.address ?? "";
			sessionIdRef.current = info.sessionId;
			setActiveCoordinatorSession(info.sessionId);
			const existingHistory = coordinator.historyBySession.get(info.sessionId) ?? [];
			setSessionHistory(existingHistory);
			// If resuming a long-lived session after a page reload, populate earlier-session list silently without auto-inserting old photos.
			const cursor = getConsumedCursor(info.sessionId);
			if (cursor > 0 && existingHistory.length < cursor && !coordinator.backfilledSessions.has(info.sessionId)) {
				coordinator.backfilledSessions.add(info.sessionId);
				void fetch(`/api/attachments/phone?sessionId=${encodeURIComponent(info.sessionId)}&since=0`, { signal })
					.then(async (res) => (res.ok ? (await res.json() as PhoneUploadPollResponse) : null))
					.then((backfill) => {
						if (!backfill?.active || !backfill.uploads.length) return;
						recordSessionUploads(info.sessionId, backfill.uploads);
					})
					.catch(() => {});
			}
			setSession(info);
			setSelectedAddress(nextLan);
			setTunnelStatus(info.tunnelStatus ?? "off");
			setTunnelUrl(info.tunnelUrl ?? null);
			setTunnelError(info.tunnelError ?? null);
			if (info.tunnelStatus === "error" && nextLan) {
				setConnectionMode("lan");
			}
		} catch (err) {
			if (signal.aborted) return;
			setError(err instanceof Error ? err.message : "Could not start phone upload server.");
		} finally {
			if (!signal.aborted) setLoading(false);
		}
	}, []);

	useEffect(() => {
		const abort = new AbortController();
		void startSession(abort.signal);
		return () => {
			abort.abort();
			// Intentionally keep the phone companion session alive when closing the QR dialog.
		};
	}, [startSession, reloadNonce]);

	const disconnectSession = () => {
		const activeId = sessionIdRef.current ?? getActiveCoordinatorSession();
		sessionIdRef.current = null;
		clearCoordinatorSession(activeId);
		if (activeId) stopSessionRequest(activeId);
		onClose();
	};

	useEffect(() => () => {
		if (receivedCountRef.current > 0) {
			// Reclaim focus back to the input after HostDialog's unmount focus restoration.
			setTimeout(() => {
				try {
					if (editorRef.current?.isConnected) editorRef.current.focus();
				} catch {
					// Ignore focus restoration failures during host teardown.
				}
			}, 10);
		}
	}, [editorRef]);

	useEffect(() => {
		if (!session?.sessionId) return;
		const sessionId = session.sessionId;
		let cancelled = false;
		const poll = async () => {
			if (cancelled || sessionIdRef.current !== sessionId || coordinator.inFlightSessions.has(sessionId)) return;
			coordinator.inFlightSessions.add(sessionId);
			try {
				const cursor = getConsumedCursor(sessionId);
				const res = await fetch(
					`/api/attachments/phone?sessionId=${encodeURIComponent(sessionId)}&since=${cursor}`,
				);
				if (!res.ok || cancelled) return;
				const data = await res.json() as PhoneUploadPollResponse;
				if (cancelled) return;
				if (!data.active) {
					clearCoordinatorSession(sessionId);
					setError("Phone upload session expired. Click New code to start a new one.");
					return;
				}
				if (data.tunnelStatus !== undefined) setTunnelStatus(data.tunnelStatus);
				if (data.tunnelUrl !== undefined) setTunnelUrl(data.tunnelUrl);
				if (data.tunnelError !== undefined) setTunnelError(data.tunnelError);
				const latestCursor = getConsumedCursor(sessionId);
				const freshUploads = data.uploads.filter((item) => item.index >= latestCursor);
				if (data.uploads.length > 0) recordSessionUploads(sessionId, data.uploads);
				const nextCursor = Math.max(latestCursor, data.nextIndex, ...freshUploads.map((item) => item.index + 1));
				if (nextCursor > latestCursor) setConsumedCursor(sessionId, nextCursor);
				if (freshUploads.length > 0) {
					receivedCountRef.current += freshUploads.length;
					setReceived((prev) => {
						const known = new Set(prev.map((item) => item.index));
						return [...prev, ...freshUploads.filter((item) => !known.has(item.index))];
					});
					insertPathsIntoEditor(editorRef, freshUploads.map((item: AttachmentUploadResult) => item.path));
				}
			} catch {
				// Ignore transient polling hiccups while local server stays active.
			} finally {
				coordinator.inFlightSessions.delete(sessionId);
			}
		};
		const timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [session, editorRef]);

	const tunnelSupported = tunnelStatus !== "off";
	const hasReadyTunnel = tunnelStatus === "ready" && Boolean(tunnelUrl);
	const hasLan = Boolean(session && selectedAddress);
	const effectiveMode: "tunnel" | "lan" = tunnelSupported ? (hasLan ? connectionMode : "tunnel") : "lan";
	const useTunnel = effectiveMode === "tunnel";

	const activeUrl = useMemo(() => {
		if (!session) return "";
		if (useTunnel) {
			return hasReadyTunnel && tunnelUrl ? buildPhoneTunnelUploadUrl(tunnelUrl, session.token) : "";
		}
		if (!selectedAddress) return "";
		return buildPhoneUploadUrl(selectedAddress, session.port, session.token);
	}, [session, useTunnel, hasReadyTunnel, tunnelUrl, selectedAddress]);

	const qr = useMemo(() => {
		if (!activeUrl) return null;
		const matrix = encodeQrMatrix(activeUrl);
		return { size: matrix.size, path: qrSvgPath(matrix) };
	}, [activeUrl]);

	const newIndices = useMemo(() => new Set(received.map((item) => item.index)), [received]);
	const earlierUploads = useMemo(
		() => [...sessionHistory.filter((item) => !newIndices.has(item.index))].reverse(),
		[sessionHistory, newIndices],
	);
	const insertSingleEarlier = (entry: PhoneUploadEntry) => {
		insertPathsIntoEditor(editorRef, [entry.path]);
		receivedCountRef.current += 1;
		setManuallyInserted((prev) => new Set(prev).add(entry.index));
		setSelectedEarlier((prev) => {
			if (!prev.has(entry.index)) return prev;
			const next = new Set(prev);
			next.delete(entry.index);
			return next;
		});
	};
	const insertSelectedEarlier = () => {
		const chosen = earlierUploads
			.filter((item) => selectedEarlier.has(item.index))
			.sort((a, b) => a.index - b.index);
		if (chosen.length === 0) return;
		insertPathsIntoEditor(editorRef, chosen.map((item) => item.path));
		receivedCountRef.current += chosen.length;
		setManuallyInserted((prev) => {
			const next = new Set(prev);
			for (const item of chosen) next.add(item.index);
			return next;
		});
		setSelectedEarlier(new Set());
	};

	const firstWarning = received.find((item) => item.warning)?.warning ?? null;

	return (
		<div className="flex flex-col gap-3.5">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="text-base font-semibold leading-tight">ChronoHarness Mobile Companion</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						Scan with your phone camera (4G/5G, any Wi-Fi, or local network) to upload work photos, review due FSRS-6 flashcards, and track Exam Prep.
					</p>
				</div>
				<button
					type="button"
					aria-label="Close"
					onClick={onClose}
					className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" aria-hidden />
				</button>
			</div>

			{loading ? (
				<div className="flex h-52 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
					Starting local receiver…
				</div>
			) : error ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-center text-sm text-destructive">
					<p>{error}</p>
					<Button type="button" variant="outline" size="sm" onClick={() => setReloadNonce((n) => n + 1)}>
						<RefreshCwIcon className="size-3.5" aria-hidden />
						Refresh QR
					</Button>
				</div>
			) : (
				<div className="flex flex-col items-center gap-3">
					{tunnelSupported && hasLan && (
						<div
							data-testid="phone-mode-toggle"
							className="inline-flex w-full rounded-lg border border-border bg-muted/40 p-0.5 text-xs"
						>
							<button
								type="button"
								data-testid="phone-mode-tunnel"
								aria-pressed={useTunnel}
								onClick={() => setConnectionMode("tunnel")}
								className={`flex-1 rounded-md px-2.5 py-1 font-medium transition-colors ${
									useTunnel ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
								}`}
							>
								Any network (HTTPS)
							</button>
							<button
								type="button"
								data-testid="phone-mode-lan"
								aria-pressed={!useTunnel}
								onClick={() => setConnectionMode("lan")}
								className={`flex-1 rounded-md px-2.5 py-1 font-medium transition-colors ${
									!useTunnel ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"
								}`}
							>
								Same Wi-Fi (LAN)
							</button>
						</div>
					)}

					{useTunnel && !hasReadyTunnel ? (
						tunnelStatus === "starting" ? (
							<div
								data-testid="phone-tunnel-starting"
								className="flex h-52 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 text-center text-sm text-muted-foreground"
							>
								<span>Opening cross-network link (4G / any Wi-Fi)…</span>
								{hasLan && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										data-testid="phone-switch-lan-now"
										onClick={() => setConnectionMode("lan")}
									>
										Use Same Wi-Fi (LAN) now
									</Button>
								)}
							</div>
						) : (
							<div
								data-testid="phone-tunnel-error"
								className="flex w-full flex-col gap-2.5 rounded-xl border border-border/80 bg-muted/40 p-4 text-sm text-muted-foreground"
							>
								<p>
									{hasLan
										? `Cross-network link unavailable${tunnelError ? ` (${tunnelError})` : ""}. Retry or switch to Same Wi-Fi (LAN).`
										: `No LAN Wi-Fi or Ethernet IPv4 address was detected on this computer${tunnelError ? ` (${tunnelError})` : ""}. Connect both devices to the same network, then click Refresh QR.`}
								</p>
								<div className="flex flex-wrap items-center gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											refreshTunnelRef.current = true;
											setReloadNonce((n) => n + 1);
										}}
									>
										<RefreshCwIcon className="size-3.5" aria-hidden />
										{hasLan ? "Retry HTTPS link" : "Refresh QR"}
									</Button>
									{hasLan && (
										<Button type="button" size="sm" onClick={() => setConnectionMode("lan")}>
											Use Same Wi-Fi (LAN)
										</Button>
									)}
								</div>
							</div>
						)
					) : !useTunnel && !hasLan ? (
						<div className="flex w-full flex-col gap-2 rounded-xl border border-border/80 bg-muted/40 p-4 text-sm text-muted-foreground">
							<p>
								No LAN Wi-Fi or Ethernet IPv4 address was detected on this computer. Connect both devices to the same network, then click Refresh QR.
							</p>
							<div>
								<Button type="button" variant="outline" size="sm" onClick={() => setReloadNonce((n) => n + 1)}>
									<RefreshCwIcon className="size-3.5" aria-hidden />
									Refresh QR
								</Button>
							</div>
						</div>
					) : (
						<>
							{qr && (
								<div className="rounded-xl border border-border bg-white p-3 shadow-xs">
									<svg
										role="img"
										aria-label="QR code for phone photo upload"
										viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`}
										className="size-48"
										shapeRendering="crispEdges"
									>
										<rect x={-4} y={-4} width={qr.size + 8} height={qr.size + 8} fill="#ffffff" />
										<path d={qr.path} fill="#09090b" />
									</svg>
								</div>
							)}

							{!useTunnel && tunnelStatus === "starting" && (
								<p data-testid="phone-tunnel-starting" className="text-center text-[11px] text-muted-foreground">
									Cross-network link (4G / any Wi-Fi) is opening in the background…
								</p>
							)}

							{!useTunnel && tunnelStatus === "error" && (
								<p data-testid="phone-tunnel-error" className="text-center text-[11px] text-muted-foreground">
									Cross-network link unavailable{tunnelError ? ` (${tunnelError})` : ""} — using local Wi-Fi.
								</p>
							)}

							{session && !useTunnel && session.addresses.length > 1 && (
								<label className="flex w-full items-center gap-2 text-xs text-muted-foreground">
									<span className="shrink-0">Network IP</span>
									<select
										aria-label="Network IP"
										value={selectedAddress}
										onChange={(e) => setSelectedAddress(e.target.value)}
										className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
									>
										{session.addresses.map((cand) => (
											<option key={cand.address} value={cand.address}>
												{cand.address} ({cand.interfaceName}){cand.recommended ? " · Recommended" : ""}
											</option>
										))}
									</select>
								</label>
							)}

							{activeUrl && (
								<div className="flex w-full items-center gap-1.5 rounded-lg border border-border/80 bg-muted/30 px-2.5 py-1.5">
									<code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
										{activeUrl}
									</code>
									<button
										type="button"
										aria-label="Copy link"
										onClick={() => {
											void navigator.clipboard?.writeText(activeUrl).then(() => {
												setCopied(true);
												setTimeout(() => setCopied(false), 1500);
											}).catch(() => {});
										}}
										className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
									>
										{copied ? <CheckCircle2Icon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
									</button>
								</div>
							)}
						</>
					)}
				</div>
			)}

			{(received.length > 0 || earlierUploads.length > 0) && (
				<div className="space-y-2">
					{received.length > 0 && (
						<div data-testid="phone-upload-received" className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border/70 bg-muted/20 p-2.5">
							<div className="text-xs font-medium text-foreground">
								Inserted into draft ({received.length})
							</div>
							{received.map((entry) => (
								<div key={entry.index} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
									<span className="truncate font-mono">{entry.filename}</span>
									<span className="shrink-0">{formatBytes(entry.size)}</span>
								</div>
							))}
						</div>
					)}
					{earlierUploads.length > 0 && (
						<div data-testid="phone-upload-earlier" className="max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-border/70 bg-background/60 p-2.5">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="text-xs font-medium text-foreground">
									Earlier in this session ({earlierUploads.length})
								</span>
								<div className="flex items-center gap-1.5">
									{earlierUploads.length > 1 && (
										<button
											type="button"
											onClick={() => {
												if (selectedEarlier.size === earlierUploads.length) {
													setSelectedEarlier(new Set());
												} else {
													setSelectedEarlier(new Set(earlierUploads.map((item) => item.index)));
												}
											}}
											className="text-[11px] text-muted-foreground hover:text-foreground"
										>
											{selectedEarlier.size === earlierUploads.length ? "Clear" : "Select all"}
										</button>
									)}
									{selectedEarlier.size > 0 && (
										<Button
											type="button"
											size="sm"
											variant="outline"
											data-testid="phone-insert-selected"
											onClick={insertSelectedEarlier}
											className="h-6 px-2 text-[11px]"
										>
											Insert selected ({selectedEarlier.size})
										</Button>
									)}
								</div>
							</div>
							{earlierUploads.map((entry) => (
								<div key={entry.index} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
									<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5">
										<input
											type="checkbox"
											aria-label={`Select ${entry.filename}`}
											checked={selectedEarlier.has(entry.index)}
											onChange={(e) => {
												setSelectedEarlier((prev) => {
													const next = new Set(prev);
													if (e.target.checked) next.add(entry.index);
													else next.delete(entry.index);
													return next;
												});
											}}
										/>
										<span className="truncate font-mono">{entry.filename}</span>
									</label>
									<span className="shrink-0 text-[11px]">{formatBytes(entry.size)}</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										data-testid={`phone-insert-${entry.index}`}
										onClick={() => insertSingleEarlier(entry)}
										className="h-6 shrink-0 px-2 text-[11px]"
									>
										{manuallyInserted.has(entry.index) ? "Inserted ✓" : "+ Insert"}
									</Button>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{firstWarning && (
				<p role="alert" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
					{firstWarning}
				</p>
			)}

			<div className="space-y-1.5 pt-1">
				<p className="text-[11px] text-muted-foreground">
					Closing this dialog keeps your phone connected in the background.
				</p>
				<div className="flex items-center justify-between gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={!session?.sessionId}
						onClick={disconnectSession}
						className="text-muted-foreground hover:bg-error/10 hover:text-error"
						title="Close phone companion server and invalidate the current QR link"
					>
						<PowerIcon className="size-3.5" aria-hidden />
						Disconnect
					</Button>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								forceNewRef.current = true;
								refreshTunnelRef.current = tunnelStatus === "error";
								setReloadNonce((n) => n + 1);
							}}
						>
							<RefreshCwIcon className="size-3.5" aria-hidden />
							New code
						</Button>
						<Button type="button" size="sm" onClick={onClose}>
							{received.length > 0 ? `Done (${received.length})` : "Done"}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

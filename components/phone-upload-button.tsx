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
	const [bgSessionId, setBgSessionId] = useState<string | null>(null);
	const prewarmRequestedRef = useRef(false);
	const sharedSinceRef = useRef(0);
	const prevSessionIdRef = useRef<string | null>(null);

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

	// Keep polling received camera uploads quietly in the background after the QR modal closes.
	useEffect(() => {
		if (open || !bgSessionId || disabled || typeof fetch !== "function") return;
		let cancelled = false;
		const pollBackground = async () => {
			if (cancelled) return;
			try {
				const res = await fetch(
					`/api/attachments/phone?sessionId=${encodeURIComponent(bgSessionId)}&since=${sharedSinceRef.current}`,
				);
				if (!res.ok || cancelled) return;
				const data = (await res.json()) as PhoneUploadPollResponse;
				if (cancelled) return;
				if (!data.active) {
					setBgSessionId(null);
					return;
				}
				if (data.uploads.length > 0) {
					sharedSinceRef.current = data.nextIndex;
					const paths = data.uploads.map((item: AttachmentUploadResult) => item.path);
					editorRef.current?.dispatchEvent(
						new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: { paths, focus: false } }),
					);
				}
			} catch {
				// Ignore transient polling hiccups while companion server runs.
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
						sinceRef={sharedSinceRef}
						prevSessionIdRef={prevSessionIdRef}
						onSessionActive={setBgSessionId}
						onClose={() => setOpen(false)}
					/>
				)}
			</HostDialog>
		</>
	);
}

function PhoneUploadDialogBody({
	editorRef,
	sinceRef,
	prevSessionIdRef,
	onSessionActive,
	onClose,
}: {
	editorRef: RefObject<HTMLDivElement | null>;
	sinceRef: MutableRefObject<number>;
	prevSessionIdRef: MutableRefObject<string | null>;
	onSessionActive: (sessionId: string | null) => void;
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
	const [copied, setCopied] = useState(false);
	const [reloadNonce, setReloadNonce] = useState(0);

	const sessionIdRef = useRef<string | null>(null);
	const receivedCountRef = useRef(0);
	const refreshTunnelRef = useRef(false);
	const forceNewRef = useRef(false);

	const startSession = useCallback(async (signal: AbortSignal) => {
		const refreshTunnel = refreshTunnelRef.current;
		const forceNew = forceNewRef.current;
		refreshTunnelRef.current = false;
		forceNewRef.current = false;
		setLoading(true);
		setError("");
		setReceived([]);
		setTunnelStatus("off");
		setTunnelUrl(null);
		setTunnelError(null);
		receivedCountRef.current = 0;

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
			if (forceNew || prevSessionIdRef.current !== info.sessionId) {
				sinceRef.current = 0;
				prevSessionIdRef.current = info.sessionId;
			}
			const nextLan = info.defaultAddress ?? info.addresses[0]?.address ?? "";
			sessionIdRef.current = info.sessionId;
			onSessionActive(info.sessionId);
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
	}, [onSessionActive, prevSessionIdRef, sinceRef]);

	useEffect(() => {
		const abort = new AbortController();
		void startSession(abort.signal);
		return () => {
			abort.abort();
			// Intentionally keep the phone companion session alive when closing the QR dialog.
		};
	}, [startSession, reloadNonce]);

	const disconnectSession = () => {
		const activeId = sessionIdRef.current ?? prevSessionIdRef.current;
		sessionIdRef.current = null;
		prevSessionIdRef.current = null;
		sinceRef.current = 0;
		if (activeId) stopSessionRequest(activeId);
		onSessionActive(null);
		onClose();
	};

	useEffect(() => () => {
		if (receivedCountRef.current > 0) {
			// Reclaim focus back to the input after HostDialog's unmount focus restoration.
			setTimeout(() => {
				if (editorRef.current?.isConnected) editorRef.current.focus();
			}, 10);
		}
	}, [editorRef]);

	useEffect(() => {
		if (!session?.sessionId) return;
		let cancelled = false;
		const poll = async () => {
			if (cancelled || sessionIdRef.current !== session.sessionId) return;
			try {
				const res = await fetch(
					`/api/attachments/phone?sessionId=${encodeURIComponent(session.sessionId)}&since=${sinceRef.current}`,
				);
				if (!res.ok || cancelled) return;
				const data = await res.json() as PhoneUploadPollResponse;
				if (cancelled) return;
				if (!data.active) {
					onSessionActive(null);
					setError("Phone upload session expired. Click New code to start a new one.");
					return;
				}
				if (data.tunnelStatus !== undefined) setTunnelStatus(data.tunnelStatus);
				if (data.tunnelUrl !== undefined) setTunnelUrl(data.tunnelUrl);
				if (data.tunnelError !== undefined) setTunnelError(data.tunnelError);
				if (data.uploads.length > 0) {
					sinceRef.current = data.nextIndex;
					receivedCountRef.current += data.uploads.length;
					setReceived((prev) => [...prev, ...data.uploads]);
					const paths = data.uploads.map((item: AttachmentUploadResult) => item.path);
					editorRef.current?.dispatchEvent(
						new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: { paths, focus: false } }),
					);
				}
			} catch {
				// Ignore transient polling hiccups while local server stays active.
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

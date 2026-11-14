"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CheckCircle2Icon, CopyIcon, RefreshCwIcon, SmartphoneIcon, XIcon } from "lucide-react";
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

	return (
		<>
			<Hint label="Upload photos from phone">
				<button
					type="button"
					data-testid="phone-upload"
					aria-label="Upload photos from phone"
					aria-haspopup="dialog"
					aria-expanded={open}
					disabled={disabled}
					onClick={() => { if (!disabled) setOpen(true); }}
					className={cn(
						"flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
						compact ? "size-8 rounded-md" : "size-10 rounded-[10px]",
					)}
				>
					<SmartphoneIcon className="size-4" aria-hidden />
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
				{open && <PhoneUploadDialogBody editorRef={editorRef} onClose={() => setOpen(false)} />}
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
	const [copied, setCopied] = useState(false);
	const [reloadNonce, setReloadNonce] = useState(0);

	const sessionIdRef = useRef<string | null>(null);
	const sinceRef = useRef(0);
	const receivedCountRef = useRef(0);

	const startSession = useCallback(async (signal: AbortSignal) => {
		setLoading(true);
		setError("");
		setReceived([]);
		setConnectionMode("tunnel");
		setTunnelStatus("off");
		setTunnelUrl(null);
		setTunnelError(null);
		sinceRef.current = 0;
		receivedCountRef.current = 0;

		const previous = sessionIdRef.current;
		if (previous) {
			sessionIdRef.current = null;
			stopSessionRequest(previous);
		}

		try {
			const response = await fetch("/api/attachments/phone", { method: "POST", signal });
			const payload = await response.json().catch(() => ({})) as Partial<PhoneUploadSessionInfo> & { error?: string };
			if (!response.ok || !payload.sessionId || !payload.token || !payload.port) {
				throw new Error(payload.error || "Could not start phone upload server.");
			}
			if (signal.aborted) {
				stopSessionRequest(payload.sessionId);
				return;
			}
			const info = payload as PhoneUploadSessionInfo;
			sessionIdRef.current = info.sessionId;
			setSession(info);
			setSelectedAddress(info.defaultAddress ?? info.addresses[0]?.address ?? "");
			setTunnelStatus(info.tunnelStatus ?? "off");
			setTunnelUrl(info.tunnelUrl ?? null);
			setTunnelError(info.tunnelError ?? null);
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
		const onPageHide = () => {
			if (sessionIdRef.current) stopSessionRequest(sessionIdRef.current);
		};
		window.addEventListener("pagehide", onPageHide);
		return () => {
			abort.abort();
			window.removeEventListener("pagehide", onPageHide);
			const activeId = sessionIdRef.current;
			sessionIdRef.current = null;
			if (activeId) stopSessionRequest(activeId);
		};
	}, [startSession, reloadNonce]);

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
					setError("Phone upload session expired. Click Refresh QR to start a new one.");
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

	const hasTunnel = tunnelStatus === "ready" && Boolean(tunnelUrl);
	const hasLan = Boolean(session && selectedAddress);
	const useTunnel = hasTunnel && (connectionMode === "tunnel" || !hasLan);

	const activeUrl = useMemo(() => {
		if (!session) return "";
		if (useTunnel && tunnelUrl) return buildPhoneTunnelUploadUrl(tunnelUrl, session.token);
		if (!selectedAddress) return "";
		return buildPhoneUploadUrl(selectedAddress, session.port, session.token);
	}, [session, useTunnel, tunnelUrl, selectedAddress]);

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
					<h2 className="text-base font-semibold leading-tight">Upload photos from phone</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						Scan with your phone camera (4G/5G, any Wi-Fi, or local network). Captured photos insert straight into your draft.
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
			) : session && !activeUrl && tunnelStatus === "starting" ? (
				<div
					data-testid="phone-tunnel-starting"
					className="flex h-52 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground"
				>
					Opening cross-network link (4G / any Wi-Fi)…
				</div>
			) : session && !activeUrl ? (
				<div className="flex flex-col gap-2 rounded-xl border border-border/80 bg-muted/40 p-4 text-sm text-muted-foreground">
					<p>
						No LAN Wi-Fi or Ethernet IPv4 address was detected on this computer{tunnelStatus === "error" && tunnelError ? ` (${tunnelError})` : ""}. Connect both devices to the same network, then click Refresh QR.
					</p>
					<div>
						<Button type="button" variant="outline" size="sm" onClick={() => setReloadNonce((n) => n + 1)}>
							<RefreshCwIcon className="size-3.5" aria-hidden />
							Refresh QR
						</Button>
					</div>
				</div>
			) : (
				<div className="flex flex-col items-center gap-3">
					{hasTunnel && hasLan && (
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

					{tunnelStatus === "starting" && (
						<p data-testid="phone-tunnel-starting" className="text-center text-[11px] text-muted-foreground">
							Opening cross-network link (4G / any Wi-Fi)…
						</p>
					)}

					{tunnelStatus === "error" && (
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

			<div className="flex items-center justify-end gap-2 pt-1">
				<Button type="button" variant="outline" size="sm" onClick={() => setReloadNonce((n) => n + 1)}>
					<RefreshCwIcon className="size-3.5" aria-hidden />
					New code
				</Button>
				<Button type="button" size="sm" onClick={onClose}>
					{received.length > 0 ? `Done (${received.length})` : "Done"}
				</Button>
			</div>
		</div>
	);
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, CopyIcon, GlobeIcon, PowerIcon, RefreshCwIcon, XIcon } from "lucide-react";
import {
	buildWebShareLanUrl,
	encodeQrMatrix,
	qrSvgPath,
	type WebShareSessionInfo,
} from "@/src/core";
import { HostDialog } from "@/components/host-dialog";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";

const POLL_MS = 1_800;

/** Host-side trigger & QR/link dialog for sharing the full ChronoHarness web app. */
export function WebShareButton() {
	const [open, setOpen] = useState(false);
	const [remoteClient, setRemoteClient] = useState(false);
	const [info, setInfo] = useState<WebShareSessionInfo | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [connectionMode, setConnectionMode] = useState<"tunnel" | "lan">("tunnel");
	const [selectedAddress, setSelectedAddress] = useState("");
	const [copied, setCopied] = useState(false);

	const applyInfo = useCallback((next: WebShareSessionInfo) => {
		if (next.remoteClient) {
			setRemoteClient(true);
			return;
		}
		setInfo(next);
		if (next.addresses && next.addresses.length > 0) {
			setSelectedAddress((prev) =>
				prev && next.addresses!.some((a) => a.address === prev)
					? prev
					: next.recommendedAddress ?? next.addresses![0]!.address,
			);
		}
	}, []);

	// Probe host vs remote client once on mount so the shared browser never sees host controls.
	useEffect(() => {
		let cancelled = false;
		void fetch("/api/web-share", { cache: "no-store" })
			.then(async (res) => (res.ok ? ((await res.json()) as WebShareSessionInfo) : null))
			.then((data) => {
				if (!cancelled && data) applyInfo(data);
			})
			.catch(() => {
				// Ignore in standalone render tests without an API server.
			});
		return () => {
			cancelled = true;
		};
	}, [applyInfo]);

	const startOrRefresh = useCallback(
		async (action: "start" | "refresh") => {
			setLoading(true);
			setError("");
			try {
				const res = await fetch("/api/web-share", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action }),
				});
				const payload = (await res.json().catch(() => ({}))) as Partial<WebShareSessionInfo> & { error?: string };
				if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
				applyInfo(payload as WebShareSessionInfo);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to start Web Share");
			} finally {
				setLoading(false);
			}
		},
		[applyInfo],
	);

	const stopSharing = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const res = await fetch("/api/web-share", { method: "DELETE" });
			const payload = (await res.json().catch(() => ({}))) as Partial<WebShareSessionInfo> & { error?: string };
			if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
			applyInfo(payload as WebShareSessionInfo);
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to stop Web Share");
		} finally {
			setLoading(false);
		}
	}, [applyInfo]);

	// Auto-start when dialog opens if not already running, and poll while open.
	useEffect(() => {
		if (!open || remoteClient) return;
		let cancelled = false;
		if (!info?.active) {
			void startOrRefresh("start");
		}
		const interval = setInterval(() => {
			void fetch("/api/web-share", { cache: "no-store" })
				.then(async (res) => (res.ok ? ((await res.json()) as WebShareSessionInfo) : null))
				.then((data) => {
					if (!cancelled && data) applyInfo(data);
				})
				.catch(() => {});
		}, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [open, remoteClient, info?.active, startOrRefresh, applyInfo]);

	const addresses = info?.addresses ?? [];
	const hasLan = addresses.length > 0 && Boolean(info?.port) && Boolean(info?.token);
	const lanUrl =
		hasLan && selectedAddress && info?.port && info?.token
			? buildWebShareLanUrl(selectedAddress, info.port, info.token)
			: info?.lanShareUrl ?? null;
	const tunnelReadyUrl = info?.tunnelStatus === "ready" && info.shareUrl ? info.shareUrl : null;
	const useTunnel = connectionMode === "tunnel";
	const activeUrl = useTunnel ? tunnelReadyUrl : lanUrl;

	const qr = useMemo(() => {
		if (!activeUrl) return null;
		const matrix = encodeQrMatrix(activeUrl);
		return { size: matrix.size, path: qrSvgPath(matrix) };
	}, [activeUrl]);

	if (remoteClient) return null;

	const expiryLabel = info?.expiresAt
		? new Date(info.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: null;

	return (
		<>
			<Hint label="Share full ChronoHarness web app to another laptop/Mac" side="top">
				<button
					type="button"
					onClick={() => setOpen(true)}
					data-testid="web-share-trigger"
					className="relative flex items-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<GlobeIcon className="size-3 shrink-0" />
					<span>Share</span>
					{info?.active && (
						<span
							aria-label="Web Share active"
							className="size-1.5 shrink-0 rounded-full bg-emerald-500"
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
				aria-label="Share ChronoHarness web app"
				frame={
					<div
						data-testid="web-share-dialog"
						className="w-[min(430px,calc(100vw-2rem))] rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-xl outline-none"
					/>
				}
				backdropProps={{
					className: "fixed inset-0 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[1px]",
				}}
			>
				{open && (
					<div className="flex flex-col gap-3">
						<div className="flex items-start justify-between gap-2">
							<div>
								<h2 className="text-sm font-semibold text-foreground">Share ChronoHarness Web App</h2>
								<p className="text-xs text-muted-foreground">
									Open the full ChronoHarness interface on any browser (no install or API key needed).
								</p>
							</div>
							<button
								type="button"
								aria-label="Close"
								onClick={() => setOpen(false)}
								className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<XIcon className="size-4" aria-hidden />
							</button>
						</div>

						{loading && !info?.active ? (
							<div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
								Starting authenticated share proxy…
							</div>
						) : error ? (
							<div className="flex flex-col items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-center text-sm text-destructive">
								<p>{error}</p>
								<Button type="button" variant="outline" size="sm" onClick={() => void startOrRefresh("start")}>
									<RefreshCwIcon className="size-3.5" aria-hidden />
									Retry
								</Button>
							</div>
						) : (
							<div className="flex flex-col items-center gap-3">
								{hasLan && (
									<div className="inline-flex w-full rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
										<button
											type="button"
											data-testid="web-share-mode-tunnel"
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
											data-testid="web-share-mode-lan"
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

								{useTunnel && !tunnelReadyUrl ? (
									info?.tunnelStatus === "starting" || !info ? (
										<div className="flex h-48 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-4 text-center text-sm text-muted-foreground">
											<span>Opening secure HTTPS link…</span>
											{hasLan && (
												<Button type="button" variant="outline" size="sm" onClick={() => setConnectionMode("lan")}>
													Use Same Wi-Fi link now
												</Button>
											)}
										</div>
									) : (
										<div className="flex w-full flex-col gap-2.5 rounded-xl border border-border/80 bg-muted/40 p-4 text-sm text-muted-foreground">
											<p>
												HTTPS tunnel unavailable{info?.tunnelError ? ` (${info.tunnelError})` : ""}.
												{hasLan ? " Switch to Same Wi-Fi (LAN) or retry." : " Click Refresh link to retry."}
											</p>
										</div>
									)
								) : (
									<>
										{qr && (
											<div className="rounded-xl border border-border bg-white p-3 shadow-xs">
												<svg
													role="img"
													aria-label="QR code to open ChronoHarness web app"
													viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`}
													className="size-44"
													shapeRendering="crispEdges"
												>
													<rect x={-4} y={-4} width={qr.size + 8} height={qr.size + 8} fill="#ffffff" />
													<path d={qr.path} fill="#09090b" />
												</svg>
											</div>
										)}

										{!useTunnel && addresses.length > 1 && (
											<label className="flex w-full items-center gap-2 text-xs text-muted-foreground">
												<span className="shrink-0">Network IP</span>
												<select
													aria-label="Network IP"
													value={selectedAddress}
													onChange={(e) => setSelectedAddress(e.target.value)}
													className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary"
												>
													{addresses.map((cand) => (
														<option key={cand.address} value={cand.address}>
															{cand.address} ({cand.interfaceName}){cand.recommended ? " · Recommended" : ""}
														</option>
													))}
												</select>
											</label>
										)}

										{activeUrl && (
											<div className="flex w-full items-center gap-1.5 rounded-lg border border-border/80 bg-muted/30 px-2.5 py-1.5">
												<code
													data-testid="web-share-url"
													className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
												>
													{activeUrl}
												</code>
												<Button
													type="button"
													variant="outline"
													size="xs"
													data-testid="web-share-copy"
													onClick={() => {
														void navigator.clipboard
															?.writeText(activeUrl)
															.then(() => {
																setCopied(true);
																setTimeout(() => setCopied(false), 1600);
															})
															.catch(() => {});
													}}
												>
													{copied ? (
														<>
															<CheckCircle2Icon className="size-3 text-emerald-500" aria-hidden />
															Copied
														</>
													) : (
														<>
															<CopyIcon className="size-3" aria-hidden />
															Copy
														</>
													)}
												</Button>
											</div>
										)}
									</>
								)}

								<div className="flex w-full items-center justify-between gap-2 text-[11px] text-muted-foreground">
									<span>
										{info?.lastClientAt ? "Browser connected" : "Waiting for browser…"}
										{expiryLabel ? ` · expires ${expiryLabel}` : ""}
									</span>
									<span>Closes when host exits</span>
								</div>

								<p className="w-full text-[11px] leading-relaxed text-muted-foreground">
									On older Macs (2013), open in <strong>Firefox</strong> or <strong>Chrome</strong>. Closing this popup keeps sharing running.
								</p>

								<div className="flex w-full items-center justify-between gap-2 pt-1">
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={loading}
										data-testid="web-share-refresh"
										onClick={() => void startOrRefresh("refresh")}
									>
										<RefreshCwIcon className="size-3.5" aria-hidden />
										Refresh link
									</Button>
									<Button
										type="button"
										variant="destructive"
										size="sm"
										disabled={loading}
										data-testid="web-share-stop"
										onClick={() => void stopSharing()}
									>
										<PowerIcon className="size-3.5" aria-hidden />
										Stop sharing
									</Button>
								</div>
							</div>
						)}
					</div>
				)}
			</HostDialog>
		</>
	);
}

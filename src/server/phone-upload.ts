import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import type {
	LanAddressCandidate,
	PhoneTunnelStatus,
	PhoneUploadEntry,
	PhoneUploadPollResponse,
	PhoneUploadSessionInfo,
} from "../core/attachments.ts";
import { AttachmentError, MAX_ATTACHMENT_IMAGE_BYTES, saveAttachmentImage } from "./attachments.ts";
import {
	appendMobileCompanionSessionNoteOrReply,
	getMobileCompanionSessionDetail,
	getMobileCompanionState,
	MobileCompanionError,
	rateMobileCompanionCard,
	updateMobileCompanionExamPrep,
} from "./phone-companion.ts";
import { ensureCloudflaredBinary, waitForTunnelReadiness } from "./tunnel-binary.ts";

const SESSION_TTL_MS = 15 * 60 * 1000;
const TUNNEL_IDLE_TTL_MS = 30 * 60 * 1000;
const SSH_TUNNEL_STARTUP_TIMEOUT_MS = 12_000;
const CF_TUNNEL_STARTUP_TIMEOUT_MS = 20_000;
const ANSI_CSI_RE = new RegExp("\\x1b\\[[0-9;]*[A-Za-z]", "g");
const LHR_URL_RE = /https:\/\/[a-z0-9.-]+\.lhr\.life\b/i;
const CF_URL_RE = /https:\/\/[a-z0-9.-]+\.trycloudflare\.com\b/i;

export interface TunnelSpawnerCallbacks {
	onReady: (url: string) => void;
	onError: (message: string) => void;
	pingPath?: string;
}

export type PhoneTunnelSpawner = (
	port: number,
	callbacks: TunnelSpawnerCallbacks,
) => { close: () => void };

function startSshTunnel(port: number, callbacks: TunnelSpawnerCallbacks): { close: () => void } {
	const child = spawn(
		"ssh",
		[
			"-o", "StrictHostKeyChecking=no",
			"-o", `UserKnownHostsFile=${os.devNull}`,
			"-o", "ServerAliveInterval=30",
			"-o", "ConnectTimeout=10",
			"-T",
			"-R", `80:127.0.0.1:${port}`,
			"nokey@localhost.run",
		],
		{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	);

	let settled = false;
	let closed = false;
	let stdoutBuf = "";
	let stderrTail = "";

	const killChild = () => {
		try {
			child.kill();
		} catch {
			// ignore child kill errors
		}
	};

	const timer = setTimeout(() => {
		if (settled || closed) return;
		settled = true;
		killChild();
		callbacks.onError("Cross-network tunnel timed out while starting");
	}, SSH_TUNNEL_STARTUP_TIMEOUT_MS);
	timer.unref?.();

	const handleOutput = (chunk: Buffer | string, isStderr: boolean) => {
		if (closed) return;
		const clean = (typeof chunk === "string" ? chunk : chunk.toString("utf8")).replace(ANSI_CSI_RE, "");
		if (isStderr) {
			stderrTail = (stderrTail + clean).slice(-512);
		}
		if (!settled) {
			stdoutBuf = (stdoutBuf + clean).slice(-8192);
			const match = LHR_URL_RE.exec(stdoutBuf);
			if (match) {
				settled = true;
				clearTimeout(timer);
				callbacks.onReady(match[0]);
			}
		}
	};

	child.stdout?.on("data", (d) => handleOutput(d, false));
	child.stderr?.on("data", (d) => handleOutput(d, true));
	child.on("error", (err) => {
		if (closed || settled) return;
		settled = true;
		clearTimeout(timer);
		callbacks.onError(err.message || "Failed to launch SSH tunnel");
	});
	child.on("close", (code) => {
		if (closed) return;
		clearTimeout(timer);
		if (!settled) {
			settled = true;
			const detail = stderrTail.trim().split(/\r?\n/).pop();
			callbacks.onError(detail || `SSH tunnel exited (${code ?? "unknown"})`);
		} else {
			callbacks.onError("Cross-network tunnel disconnected");
		}
	});

	return {
		close() {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			killChild();
		},
	};
}

function startCloudflareTunnel(
	port: number,
	binaryPath: string,
	callbacks: TunnelSpawnerCallbacks,
	onPreReadyFailure: () => void,
): { close: () => void } {
	const child = spawn(
		binaryPath,
		[
			"tunnel",
			"--no-autoupdate",
			"--edge-ip-version", "4",
			"--protocol", "http2",
			"--url", `http://127.0.0.1:${port}`,
		],
		{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	);

	let closed = false;
	let settled = false;
	let verifying = false;
	let tunnelUrl: string | null = null;
	let registered = false;

	const killChild = () => {
		try {
			child.kill();
		} catch {
			// ignore child kill errors
		}
	};

	const failStartup = (message?: string) => {
		if (closed || settled) return;
		settled = true;
		clearTimeout(timer);
		killChild();
		if (message) {
			// Startup failed before readiness — allow fallback if configured.
			void message;
		}
		onPreReadyFailure();
	};

	const timer = setTimeout(() => {
		failStartup("Cloudflare tunnel startup timed out");
	}, CF_TUNNEL_STARTUP_TIMEOUT_MS);
	timer.unref?.();

	const maybeVerifyAndReady = () => {
		if (closed || settled || verifying || !tunnelUrl || !registered) return;
		verifying = true;
		clearTimeout(timer);
		const candidateUrl = tunnelUrl;
		void waitForTunnelReadiness(candidateUrl, callbacks.pingPath || "/", () => closed || settled).then((live) => {
			if (closed || settled) return;
			if (live) {
				settled = true;
				callbacks.onReady(candidateUrl);
			} else {
				failStartup("Cloudflare tunnel URL failed readiness check");
			}
		});
	};

	const handleOutput = (chunk: Buffer | string) => {
		if (closed || settled) return;
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (!tunnelUrl) {
			const match = CF_URL_RE.exec(text);
			if (match) tunnelUrl = match[0];
		}
		if (!registered && /Registered tunnel connection/i.test(text)) {
			registered = true;
		}
		maybeVerifyAndReady();
	};

	child.stdout?.on("data", handleOutput);
	child.stderr?.on("data", handleOutput);
	child.on("error", () => {
		failStartup("Failed to launch cloudflared");
	});
	child.on("close", () => {
		if (closed) return;
		clearTimeout(timer);
		if (!settled) {
			failStartup("Cloudflare tunnel exited unexpectedly");
		} else {
			callbacks.onError("Cross-network tunnel disconnected");
		}
	});

	return {
		close() {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			killChild();
		},
	};
}

function defaultPhoneTunnelSpawner(port: number, callbacks: TunnelSpawnerCallbacks): { close: () => void } {
	let closed = false;
	let activeHandle: { close: () => void } | null = null;

	const startFallback = () => {
		if (closed) return;
		activeHandle = startSshTunnel(port, callbacks);
	};

	void ensureCloudflaredBinary().then((binaryPath) => {
		if (closed) return;
		if (!binaryPath) {
			startFallback();
			return;
		}
		activeHandle = startCloudflareTunnel(port, binaryPath, callbacks, () => {
			if (closed) return;
			activeHandle = null;
			startFallback();
		});
	});

	return {
		close() {
			if (closed) return;
			closed = true;
			if (activeHandle) {
				activeHandle.close();
				activeHandle = null;
			}
		},
	};
}
const VIRTUAL_IFACE_RE = /vethernet|wsl|hyper-v|docker|br-|veth|vmware|virtualbox|vbox|tailscale|zerotier|utun|\btun\b|\btap\b|\bwg\b|hamachi|radmin|loopback/i;
const PHYSICAL_IFACE_RE = /wi-fi|wifi|wlan|wireless|ethernet|\beth\d*\b|\ben\d+\b/i;

function ipv4Octets(address: string): [number, number, number, number] | null {
	const parts = address.split(".");
	if (parts.length !== 4) return null;
	const nums = parts.map((p) => Number.parseInt(p, 10));
	if (nums.some((n, i) => !Number.isInteger(n) || n < 0 || n > 255 || String(n) !== parts[i])) return null;
	return nums as [number, number, number, number];
}

function scoreCandidate(interfaceName: string, octets: [number, number, number, number]): number {
	const [a, b, c] = octets;
	let score = 0;
	if (VIRTUAL_IFACE_RE.test(interfaceName)) score -= 100;
	else if (PHYSICAL_IFACE_RE.test(interfaceName)) score += 30;

	if (a === 192 && b === 168 && c === 56) score -= 60; // VirtualBox Host-Only default subnet
	else if (a === 192 && b === 168) score += 40;
	else if (a === 10) score += 30;
	else if (a === 172 && b >= 16 && b <= 31) score += 10;
	else if (a === 100 && b >= 64 && b <= 127) score -= 40; // CGNAT / Tailscale
	return score;
}

/** Rank host LAN IPv4 addresses so real Wi-Fi/Ethernet adapters come before virtual NICs. */
export function rankLanAddresses(
	interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanAddressCandidate[] {
	const bestByAddr = new Map<string, { interfaceName: string; score: number }>();
	for (const [interfaceName, entries] of Object.entries(interfaces)) {
		if (!entries) continue;
		for (const entry of entries) {
			const family = entry.family as string | number;
			if ((family !== "IPv4" && family !== 4) || entry.internal) continue;
			const octets = ipv4Octets(entry.address);
			if (!octets) continue;
			const [a, b] = octets;
			if (a === 127 || (a === 169 && b === 254)) continue;
			const score = scoreCandidate(interfaceName, octets);
			const existing = bestByAddr.get(entry.address);
			if (!existing || score > existing.score) {
				bestByAddr.set(entry.address, { interfaceName, score });
			}
		}
	}
	return Array.from(bestByAddr.entries())
		.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
		.map(([address, meta], index) => ({
			address,
			interfaceName: meta.interfaceName,
			recommended: index === 0,
		}));
}

interface InternalPhoneSession {
	id: string;
	token: string;
	tokenBuf: Buffer;
	port: number;
	addresses: LanAddressCandidate[];
	defaultAddress: string | null;
	expiresAt: number;
	uploads: PhoneUploadEntry[];
	attachmentsDir?: string;
	flashcardsFile?: string;
	examPrepFile?: string;
	chatsDir?: string;
	server: http.Server;
	timer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
	tunnelStatus: PhoneTunnelStatus;
	tunnelUrl: string | null;
	tunnelError: string | null;
	tunnelHandle: { close: () => void } | null;
	usesStandbyTunnel: boolean;
}

interface StandbyTunnelState {
	server: http.Server | null;
	port: number;
	probeToken: string;
	handle: { close: () => void } | null;
	status: PhoneTunnelStatus;
	url: string | null;
	error: string | null;
	idleTimer: ReturnType<typeof setTimeout> | null;
	serverPromise: Promise<number> | null;
	generation: number;
	exitHookRegistered: boolean;
}

const ACTIVE_SESSION_KEY = Symbol.for("learnharness.phoneUploadSession");
const STANDBY_TUNNEL_KEY = Symbol.for("learnharness.phoneTunnelStandby");

function getActiveSession(): InternalPhoneSession | null {
	return ((globalThis as Record<symbol, unknown>)[ACTIVE_SESSION_KEY] as InternalPhoneSession | null | undefined) ?? null;
}

function setActiveSession(session: InternalPhoneSession | null): void {
	(globalThis as Record<symbol, unknown>)[ACTIVE_SESSION_KEY] = session;
}

function getStandbyTunnel(): StandbyTunnelState {
	const store = globalThis as Record<symbol, unknown>;
	let state = store[STANDBY_TUNNEL_KEY] as StandbyTunnelState | undefined;
	if (!state) {
		state = {
			server: null,
			port: 0,
			probeToken: crypto.randomBytes(12).toString("base64url"),
			handle: null,
			status: "off",
			url: null,
			error: null,
			idleTimer: null,
			serverPromise: null,
			generation: 0,
			exitHookRegistered: false,
		};
		store[STANDBY_TUNNEL_KEY] = state;
	}
	if (!state.exitHookRegistered) {
		state.exitHookRegistered = true;
		process.once("exit", () => {
			if (state?.handle) {
				try {
					state.handle.close();
				} catch {
					// ignore shutdown errors
				}
				state.handle = null;
			}
		});
	}
	return state;
}

function syncStandbyToActiveSession(standby: StandbyTunnelState): void {
	const active = getActiveSession();
	if (!active || active.closed || !active.usesStandbyTunnel) return;
	active.tunnelStatus = standby.status;
	active.tunnelUrl = standby.url;
	active.tunnelError = standby.error;
}

function resetStandbyIdleTimer(standby: StandbyTunnelState): void {
	if (standby.idleTimer) clearTimeout(standby.idleTimer);
	standby.idleTimer = setTimeout(() => {
		if (!getActiveSession()) {
			void stopPhoneUploadTunnel();
		} else {
			resetStandbyIdleTimer(standby);
		}
	}, TUNNEL_IDLE_TTL_MS);
	standby.idleTimer.unref?.();
}

async function ensureStandbyServer(standby: StandbyTunnelState): Promise<number> {
	if (standby.server && standby.port > 0) return standby.port;
	if (standby.serverPromise) return standby.serverPromise;

	standby.serverPromise = (async () => {
		const server = http.createServer((req, res) => {
			let pathname = "/";
			try {
				pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			} catch {
				sendJson(res, 400, { error: "Bad request URL" });
				return;
			}
			const probePath = `/__probe/${encodeURIComponent(standby.probeToken)}`;
			if ((req.method === "GET" || req.method === "HEAD") && pathname === probePath) {
				res.writeHead(200, {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end(req.method === "HEAD" ? undefined : "ok");
				return;
			}
			const active = getActiveSession();
			if (!active || active.closed || active.expiresAt <= Date.now()) {
				res.writeHead(404, {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-store",
				});
				res.end("No active upload session.");
				return;
			}
			handlePhoneRequest(active, req, res);
		});
		server.requestTimeout = 60_000;
		server.headersTimeout = 20_000;
		server.on("clientError", (_err, socket) => {
			if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		});
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				server.off("listening", onListening);
				reject(err);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(0, "127.0.0.1");
		});
		server.unref?.();
		const addr = server.address();
		if (!addr || typeof addr === "string") {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			throw new Error("Failed to bind standby phone tunnel gateway");
		}
		standby.server = server;
		standby.port = addr.port;
		return addr.port;
	})().finally(() => {
		standby.serverPromise = null;
	});

	return standby.serverPromise;
}

async function ensureStandbyTunnel(options?: {
	forceRestart?: boolean;
	tunnelSpawner?: PhoneTunnelSpawner;
}): Promise<StandbyTunnelState> {
	const standby = getStandbyTunnel();
	const forceRestart = Boolean(options?.forceRestart);

	if (
		!forceRestart &&
		standby.handle &&
		(standby.status === "ready" || standby.status === "starting")
	) {
		resetStandbyIdleTimer(standby);
		return standby;
	}

	const port = await ensureStandbyServer(standby);
	const gen = ++standby.generation;

	if (standby.handle) {
		try {
			standby.handle.close();
		} catch {
			// ignore tunnel shutdown errors
		}
		standby.handle = null;
	}

	standby.status = "starting";
	standby.url = null;
	standby.error = null;
	syncStandbyToActiveSession(standby);
	resetStandbyIdleTimer(standby);

	const spawner = options?.tunnelSpawner ?? defaultPhoneTunnelSpawner;
	const pingPath = `/__probe/${encodeURIComponent(standby.probeToken)}`;
	try {
		const handle = spawner(port, {
			pingPath,
			onReady: (url) => {
				if (standby.generation !== gen) return;
				standby.status = "ready";
				standby.url = url;
				standby.error = null;
				syncStandbyToActiveSession(standby);
			},
			onError: (message) => {
				if (standby.generation !== gen) return;
				standby.status = "error";
				standby.url = null;
				standby.error = message;
				syncStandbyToActiveSession(standby);
			},
		});
		if (standby.generation !== gen) {
			try {
				handle.close();
			} catch {
				// ignore
			}
		} else {
			standby.handle = handle;
		}
	} catch (err) {
		if (standby.generation === gen) {
			standby.status = "error";
			standby.url = null;
			standby.error = err instanceof Error ? err.message : "Failed to start cross-network tunnel";
			syncStandbyToActiveSession(standby);
		}
	}

	return standby;
}

/** Pre-warm the reusable HTTPS cross-network tunnel in the background with no active upload session. */
export async function warmPhoneUploadTunnel(options?: {
	refresh?: boolean;
	tunnelSpawner?: PhoneTunnelSpawner;
}): Promise<void> {
	try {
		await ensureStandbyTunnel({
			forceRestart: options?.refresh,
			tunnelSpawner: options?.tunnelSpawner,
		});
	} catch {
		// Pre-warm errors are surfaced lazily when opening the upload dialog.
	}
}

/** Tear down the standby cross-network tunnel and its loopback gateway. */
export async function stopPhoneUploadTunnel(): Promise<void> {
	const standby = getStandbyTunnel();
	standby.generation++;
	if (standby.idleTimer) {
		clearTimeout(standby.idleTimer);
		standby.idleTimer = null;
	}
	if (standby.handle) {
		try {
			standby.handle.close();
		} catch {
			// ignore tunnel shutdown errors
		}
		standby.handle = null;
	}
	standby.status = "off";
	standby.url = null;
	standby.error = null;
	standby.port = 0;
	const server = standby.server;
	standby.server = null;
	if (server) {
		server.closeAllConnections?.();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
}

function tokenMatches(actual: string, expectedBuf: Buffer): boolean {
	const actualBuf = Buffer.from(actual, "utf8");
	if (actualBuf.length !== expectedBuf.length) return false;
	return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

function buildMobileHtml(uploadEndpoint: string): string {
	const uploadEndpointLiteral = JSON.stringify(uploadEndpoint);
	const companionEndpointLiteral = JSON.stringify(uploadEndpoint.replace(/\/upload$/, "/companion"));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>KronoHarness · Mobile Companion</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; min-height: 100dvh; display: flex; justify-content: center; align-items: flex-start; background: #0f1115; color: #f3f4f6; }
  @media (prefers-color-scheme: light) {
    body { background: #f5f5f4; color: #18181b; }
    .card { background: #ffffff !important; border-color: #e4e4e7 !important; }
    .muted { color: #52525b !important; }
    .btn-secondary, .tab-btn, .pill-btn { background: #f4f4f5 !important; color: #18181b !important; border-color: #d4d4d8 !important; }
    .item, .subcard { background: #fafafa !important; border-color: #e4e4e7 !important; }
  }
  .card { width: 100%; max-width: 460px; border: 1px solid #27272a; border-radius: 16px; padding: 18px; background: #18181b; box-shadow: 0 8px 30px rgba(0,0,0,.22); }
  .header { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.01em; }
  .badge { font-size: 11px; padding: 3px 8px; border-radius: 999px; background: #27272a; color: #a1a1aa; font-weight: 600; white-space: nowrap; }
  .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 16px; }
  .tab-btn { border: 1px solid #3f3f46; background: #111114; color: #d4d4d8; border-radius: 10px; padding: 9px 6px; font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; }
  .tab-btn.active { background: #2563eb !important; color: #ffffff !important; border-color: #2563eb !important; }
  .panel { display: none; }
  .panel.active { display: block; }
  p { margin: 0 0 14px; font-size: 13px; line-height: 1.45; }
  .muted { color: #a1a1aa; }
  .actions { display: grid; gap: 10px; }
  label.btn, button.btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 48px; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer; text-align: center; user-select: none; -webkit-tap-highlight-color: transparent; border: none; }
  .btn-primary { background: #2563eb; color: #ffffff; border: 1px solid #2563eb; }
  .btn-secondary { background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; }
  input[type="file"] { display: none; }
  .list { margin-top: 14px; display: grid; gap: 8px; }
  .item, .subcard { padding: 12px; border-radius: 12px; border: 1px solid #27272a; background: #111114; font-size: 13px; }
  .item { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .opt { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12px; cursor: pointer; user-select: none; }
  .ok { color: #22c55e; font-weight: 600; }
  .err { color: #ef4444; font-weight: 600; }
  .foot { margin-top: 14px; font-size: 12px; text-align: center; }
  .q-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #60a5fa; font-weight: 650; margin-bottom: 6px; }
  .q-body { font-size: 15px; line-height: 1.5; white-space: pre-wrap; margin-bottom: 12px; }
  .ans-box { border-top: 1px solid #27272a; padding-top: 12px; margin-top: 12px; }
  .rate-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 12px; }
  .rate-btn { border: 1px solid #3f3f46; border-radius: 10px; padding: 8px 4px; background: #27272a; color: #f4f4f5; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; }
  .rate-btn small { font-size: 10px; font-weight: 400; opacity: 0.8; }
  .rate-1 { border-color: #ef4444; color: #fca5a5; }
  .rate-2 { border-color: #f59e0b; color: #fcd34d; }
  .rate-3 { border-color: #22c55e; color: #86efac; }
  .rate-4 { border-color: #3b82f6; color: #93c5fd; }
  .row-between { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .pill-row { display: flex; gap: 6px; margin-top: 8px; }
  .pill-btn { flex: 1; padding: 8px 6px; border-radius: 8px; border: 1px solid #3f3f46; background: #27272a; color: #d4d4d8; font-size: 12px; font-weight: 600; cursor: pointer; }
  .pill-btn.active { background: #2563eb !important; color: #fff !important; border-color: #2563eb !important; }
  .bar-wrap { width: 100%; height: 8px; border-radius: 999px; background: #27272a; overflow: hidden; margin: 8px 0 12px; }
  .bar-fill { height: 100%; background: #22c55e; transition: width 0.25s ease; }
  .session-item { padding: 10px; border-radius: 10px; border: 1px solid #27272a; background: #111114; margin-top: 8px; cursor: pointer; width: 100%; text-align: left; color: inherit; }
  .session-snip { margin-top: 4px; font-size: 12px; color: #a1a1aa; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .msg-list { max-height: 290px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin: 10px 0; padding-right: 2px; }
  .msg-bubble { padding: 8px 10px; border-radius: 10px; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; border: 1px solid #27272a; }
  .msg-user { background: #1e293b; border-color: #334155; align-self: flex-end; max-width: 90%; }
  .msg-assistant { background: #111114; align-self: flex-start; max-width: 96%; }
  .msg-role { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #94a3b8; margin-bottom: 3px; }
  .m-textarea { width: 100%; min-height: 68px; border-radius: 10px; border: 1px solid #3f3f46; background: #09090b; color: inherit; padding: 8px 10px; font-size: 13px; font-family: inherit; resize: vertical; margin-top: 6px; }
</style>
</head>
<body>
  <main class="card">
    <div class="header">
      <h1>KronoHarness</h1>
      <span id="top-badge" class="badge">Mobile Companion</span>
    </div>

    <div class="tabs" role="tablist">
      <button id="tab-photo" type="button" class="tab-btn active" role="tab" aria-selected="true">Photo</button>
      <button id="tab-cards" type="button" class="tab-btn" role="tab" aria-selected="false">FSRS Cards</button>
      <button id="tab-exam" type="button" class="tab-btn" role="tab" aria-selected="false">Exam &amp; Chat</button>
    </div>

    <section id="panel-photo" class="panel active">
      <p class="muted">Snap your work or pick photos from your library. They appear directly in your active input box on desktop.</p>
      <div class="actions">
        <label class="btn btn-primary">
          <span>Take Photo</span>
          <input id="cam" type="file" accept="image/*" capture="environment" />
        </label>
        <label class="btn btn-secondary">
          <span>Choose Photos</span>
          <input id="lib" type="file" accept="image/*" multiple />
        </label>
      </div>
      <label class="opt muted">
        <input id="hd" type="checkbox" />
        <span>High detail (2400px &middot; slower over 4G/5G)</span>
      </label>
      <div id="list" class="list" aria-live="polite"></div>
    </section>

    <section id="panel-cards" class="panel">
      <div class="row-between" style="margin-bottom: 10px;">
        <span id="cards-stats" class="muted" style="font-size: 12px;">Loading flashcards...</span>
        <button id="cards-refresh" type="button" class="pill-btn" style="flex: 0 0 auto; padding: 4px 10px;">Refresh</button>
      </div>
      <div id="cards-stage" class="subcard">
        <p class="muted" style="margin:0;">Open this tab to load due FSRS-6 cards.</p>
      </div>
    </section>

    <section id="panel-exam" class="panel">
      <div id="exam-overview">
        <div class="subcard" style="margin-bottom: 12px;">
          <div class="row-between">
            <strong id="exam-title" style="font-size: 14px;">Study Mode</strong>
            <span id="exam-readiness" class="badge">Readiness --%</span>
          </div>
          <div class="bar-wrap"><div id="exam-bar" class="bar-fill" style="width: 4%;"></div></div>
          <div class="muted" style="font-size: 11px;">Study Mode</div>
          <div class="pill-row">
            <button type="button" id="mode-long-term" class="pill-btn">Long-Term</button>
            <button type="button" id="mode-exam" class="pill-btn">Exam Prep</button>
          </div>
          <div class="muted" style="font-size: 11px; margin-top: 10px;">Teaching Pace</div>
          <div class="pill-row">
            <button type="button" id="pace-thorough" class="pill-btn">Thorough</button>
            <button type="button" id="pace-efficient" class="pill-btn">Efficient</button>
            <button type="button" id="pace-crash" class="pill-btn">Crash</button>
          </div>
          <div id="exam-weak" class="muted" style="font-size: 12px; margin-top: 10px;"></div>
        </div>
        <div>
          <strong style="font-size: 13px;">Recent Sessions (Tap to Read &amp; Reply)</strong>
          <div id="recent-sessions"><p class="muted" style="margin-top:6px;">Loading...</p></div>
        </div>
      </div>

      <div id="session-reader" style="display: none;">
        <div class="row-between" style="margin-bottom: 8px;">
          <button type="button" id="session-back-btn" class="pill-btn" style="flex: 0 0 auto; padding: 5px 10px;">&larr; Sessions</button>
          <span id="session-reader-mode" class="badge">Teach</span>
          <button type="button" id="session-refresh-btn" class="pill-btn" style="flex: 0 0 auto; padding: 5px 10px;">Refresh</button>
        </div>
        <strong id="session-reader-title" style="font-size: 14px; display: block; margin-bottom: 6px;">Session</strong>
        <div id="session-pending" class="subcard" style="display: none; border-color: #f59e0b; margin-bottom: 8px; font-size: 12.5px;"></div>
        <div id="session-messages" class="msg-list"></div>
        <div class="subcard" style="margin-top: 8px;">
          <strong style="font-size: 12px;">Reply to Tutor / Practice</strong>
          <textarea id="session-reply-input" class="m-textarea" placeholder="Type your answer or question from phone..."></textarea>
          <div class="row-between" style="margin-top: 6px;">
            <span id="session-reply-status" class="muted" style="font-size: 11px;"></span>
            <button type="button" id="session-reply-send" class="pill-btn active" style="flex: 0 0 auto; padding: 7px 14px;">Send Reply</button>
          </div>
        </div>
        <div class="subcard" style="margin-top: 8px;">
          <div class="row-between">
            <strong style="font-size: 12px;">Lesson Notes (Synced to PC)</strong>
            <span id="session-note-status" class="muted" style="font-size: 11px;"></span>
          </div>
          <textarea id="session-notes-input" class="m-textarea" placeholder="Quick notes from phone..."></textarea>
          <button type="button" id="session-note-save" class="pill-btn" style="margin-top: 6px; width: 100%;">Save Note</button>
        </div>
      </div>
    </section>

    <p class="muted foot">Synced directly with desktop storage over local Wi-Fi or secure tunnel.</p>
  </main>
<script>
(() => {
  const UPLOAD_URL = ${uploadEndpointLiteral};
  const COMPANION_URL = ${companionEndpointLiteral};
  const cam = document.getElementById("cam");
  const lib = document.getElementById("lib");
  const hd = document.getElementById("hd");
  const list = document.getElementById("list");
  const topBadge = document.getElementById("top-badge");
  const CONCURRENCY = 2;
  const pending = [];
  let inFlight = 0;

  let companionState = null;
  let cardRevealed = false;
  let cardBusy = false;

  const tabs = [
    { btn: document.getElementById("tab-photo"), panel: document.getElementById("panel-photo") },
    { btn: document.getElementById("tab-cards"), panel: document.getElementById("panel-cards") },
    { btn: document.getElementById("tab-exam"), panel: document.getElementById("panel-exam") },
  ];

  function activateTab(idx) {
    tabs.forEach((t, i) => {
      const on = i === idx;
      t.btn.classList.toggle("active", on);
      t.btn.setAttribute("aria-selected", on ? "true" : "false");
      t.panel.classList.toggle("active", on);
    });
    if (idx > 0 && !companionState) {
      void loadCompanionState();
    }
  }
  tabs.forEach((t, i) => t.btn.addEventListener("click", () => activateTab(i)));

  function renderCards() {
    const statsEl = document.getElementById("cards-stats");
    const stageEl = document.getElementById("cards-stage");
    const cardsTabBtn = document.getElementById("tab-cards");
    if (!companionState) {
      statsEl.textContent = "Loading flashcards...";
      return;
    }
    const dueCount = companionState.totalDue || 0;
    const queueLen = companionState.dueCards.length;
    cardsTabBtn.textContent = dueCount > 0 ? ("FSRS Cards (" + dueCount + ")") : "FSRS Cards";
    statsEl.textContent = dueCount + " due · " + queueLen + " ready · " + (companionState.totalTracked || 0) + " tracked";
    stageEl.innerHTML = "";

    const card = companionState.dueCards[0];
    if (!card) {
      const done = document.createElement("p");
      done.className = "muted";
      done.style.margin = "0";
      done.textContent = "All FSRS-6 flashcards are caught up!";
      stageEl.append(done);
      return;
    }

    const head = document.createElement("div");
    head.className = "row-between";
    const title = document.createElement("div");
    title.className = "q-title";
    title.textContent = card.propositionName + (card.isDue ? " · DUE" : " · NEW");
    const meta = document.createElement("span");
    meta.className = "badge";
    meta.textContent = card.isDue ? ("R=" + Math.round((card.retrievability || 0) * 100) + "%") : "New";
    head.append(title, meta);

    const q = document.createElement("div");
    q.id = "card-q";
    q.className = "q-body";
    q.textContent = card.question;
    stageEl.append(head, q);

    if (!cardRevealed) {
      const flipBtn = document.createElement("button");
      flipBtn.id = "flip-card-btn";
      flipBtn.type = "button";
      flipBtn.className = "btn btn-primary";
      flipBtn.textContent = "Show Answer";
      flipBtn.onclick = () => {
        cardRevealed = true;
        renderCards();
      };
      stageEl.append(flipBtn);
      return;
    }

    const ansBox = document.createElement("div");
    ansBox.className = "ans-box";
    const ansLabel = document.createElement("div");
    ansLabel.className = "q-title";
    ansLabel.style.color = "#22c55e";
    ansLabel.textContent = "Answer";
    const ansText = document.createElement("div");
    ansText.id = "card-a";
    ansText.className = "q-body";
    ansText.textContent = card.answer;
    ansBox.append(ansLabel, ansText);

    if (card.statement) {
      const stmt = document.createElement("div");
      stmt.id = "card-stmt";
      stmt.className = "muted";
      stmt.style.fontSize = "12px";
      stmt.textContent = "Statement: " + card.statement;
      ansBox.append(stmt);
    }

    const grid = document.createElement("div");
    grid.className = "rate-grid";
    const ratings = [
      { id: 1, label: "Again" },
      { id: 2, label: "Hard" },
      { id: 3, label: "Good" },
      { id: 4, label: "Easy" },
    ];
    for (const r of ratings) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rate-btn rate-" + r.id;
      btn.disabled = cardBusy;
      const lbl = document.createElement("span");
      lbl.textContent = r.label;
      const iv = document.createElement("small");
      iv.textContent = (card.intervals && card.intervals[String(r.id)]) || "";
      btn.append(lbl, iv);
      btn.onclick = () => void submitCardRating(card, r.id);
      grid.append(btn);
    }
    ansBox.append(grid);
    stageEl.append(ansBox);
  }

  function renderExam() {
    if (!companionState || !companionState.examPrep) return;
    const ep = companionState.examPrep;
    const cfg = ep.config || {};
    const titleEl = document.getElementById("exam-title");
    const readyEl = document.getElementById("exam-readiness");
    const barEl = document.getElementById("exam-bar");
    const weakEl = document.getElementById("exam-weak");
    const sessionsEl = document.getElementById("recent-sessions");

    const dText = ep.daysRemaining == null
      ? ""
      : ep.daysRemaining > 0 ? (" · D-" + ep.daysRemaining)
      : ep.daysRemaining === 0 ? " · Today"
      : (" · +" + Math.abs(ep.daysRemaining) + "d");

    titleEl.textContent = (cfg.mode === "exam" ? (cfg.examTitle || "Exam Prep") : "Long-Term Mastery") + dText;
    readyEl.textContent = "Readiness " + (ep.examReadinessPct || 0) + "%";
    topBadge.textContent = "Readiness " + (ep.examReadinessPct || 0) + "%" + dText;
    barEl.style.width = Math.min(100, Math.max(4, ep.examReadinessPct || 0)) + "%";
    barEl.style.background = (ep.examReadinessPct || 0) >= 80 ? "#22c55e" : (ep.examReadinessPct || 0) >= 55 ? "#f59e0b" : "#ef4444";

    document.getElementById("mode-long-term").classList.toggle("active", cfg.mode === "long-term");
    document.getElementById("mode-exam").classList.toggle("active", cfg.mode === "exam");
    document.getElementById("pace-thorough").classList.toggle("active", cfg.pace === "thorough");
    document.getElementById("pace-efficient").classList.toggle("active", cfg.pace === "efficient");
    document.getElementById("pace-crash").classList.toggle("active", cfg.pace === "crash-course");

    const weakNames = ep.weakFoundationNames || [];
    const dueNames = ep.duePropositionNames || [];
    weakEl.textContent = weakNames.length
      ? ("Weak foundations: " + weakNames.join(", "))
      : dueNames.length
      ? ("Due next: " + dueNames.join(", "))
      : "No overdue foundational concepts right now.";

    sessionsEl.innerHTML = "";
    const sessions = companionState.recentSessions || [];
    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.style.marginTop = "6px";
      empty.textContent = "No recent desktop sessions yet.";
      sessionsEl.append(empty);
      return;
    }
    for (const s of sessions) {
      const box = document.createElement("button");
      box.type = "button";
      box.className = "session-item";
      box.onclick = () => void openSessionReader(s.id);
      const top = document.createElement("div");
      top.className = "row-between";
      const name = document.createElement("strong");
      name.style.fontSize = "12px";
      name.textContent = s.title;
      const modeTag = document.createElement("span");
      modeTag.className = "badge";
      modeTag.textContent = (s.mode === "practice" ? "Practice" : "Teach") + " · Open";
      top.append(name, modeTag);
      box.append(top);
      if (s.lastAssistantSnippet) {
        const snip = document.createElement("div");
        snip.className = "session-snip";
        snip.textContent = s.lastAssistantSnippet;
        box.append(snip);
      }
      sessionsEl.append(box);
    }
  }

  let activeSessionId = null;

  function closeSessionReader() {
    activeSessionId = null;
    document.getElementById("session-reader").style.display = "none";
    document.getElementById("exam-overview").style.display = "block";
  }

  function renderSessionDetail(detail) {
    document.getElementById("exam-overview").style.display = "none";
    document.getElementById("session-reader").style.display = "block";
    document.getElementById("session-reader-title").textContent = detail.title || "Session";
    document.getElementById("session-reader-mode").textContent = detail.mode === "practice" ? "Practice" : "Teach";

    const pendingEl = document.getElementById("session-pending");
    if (detail.pendingQuestionPrompt) {
      pendingEl.style.display = "block";
      pendingEl.textContent = detail.pendingQuestionPrompt;
    } else {
      pendingEl.style.display = "none";
      pendingEl.textContent = "";
    }

    const msgList = document.getElementById("session-messages");
    msgList.innerHTML = "";
    const msgs = detail.messages || [];
    if (!msgs.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No messages in this session yet.";
      msgList.append(empty);
    } else {
      for (const m of msgs) {
        const bubble = document.createElement("div");
        bubble.className = "msg-bubble " + (m.role === "user" ? "msg-user" : "msg-assistant");
        const role = document.createElement("div");
        role.className = "msg-role";
        role.textContent = m.role === "user" ? "You" : "Tutor";
        const body = document.createElement("div");
        body.textContent = m.text;
        bubble.append(role, body);
        msgList.append(bubble);
      }
      msgList.scrollTop = msgList.scrollHeight;
    }
    document.getElementById("session-notes-input").value = detail.notes || "";
  }

  async function openSessionReader(chatId) {
    activeSessionId = chatId;
    document.getElementById("session-reply-status").textContent = "";
    document.getElementById("session-note-status").textContent = "";
    try {
      const res = await fetch(COMPANION_URL + "/session?chatId=" + encodeURIComponent(chatId), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const detail = await res.json();
      renderSessionDetail(detail);
    } catch {
      document.getElementById("session-reply-status").textContent = "Failed to load session";
    }
  }

  async function sendMobileSessionAction(payload, statusElId, btnEl) {
    if (!activeSessionId) return;
    const statusEl = document.getElementById(statusElId);
    statusEl.textContent = "Sending...";
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await fetch(COMPANION_URL + "/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: activeSessionId, ...payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        statusEl.textContent = data.error || ("HTTP " + res.status);
        return;
      }
      if (data.session) renderSessionDetail(data.session);
      if (payload.replyText) {
        document.getElementById("session-reply-input").value = "";
        statusEl.textContent = data.triggeredAiTurn ? "Sent · Tutor replying..." : "Saved to session";
        if (data.triggeredAiTurn) {
          setTimeout(() => { if (activeSessionId === data.session?.id) void openSessionReader(activeSessionId); }, 2500);
        }
      } else {
        statusEl.textContent = "Note saved";
      }
    } catch {
      statusEl.textContent = "Network error";
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function loadCompanionState() {
    try {
      const res = await fetch(COMPANION_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      companionState = await res.json();
      cardRevealed = false;
      renderCards();
      renderExam();
    } catch {
      document.getElementById("cards-stats").textContent = "Could not load companion state.";
    }
  }

  async function submitCardRating(card, rating) {
    if (cardBusy) return;
    cardBusy = true;
    renderCards();
    try {
      const res = await fetch(COMPANION_URL + "/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propositionId: card.propositionId, cueId: card.cueId, rating }),
      });
      if (res.ok) {
        const data = await res.json();
        companionState = data.state;
        cardRevealed = false;
      }
    } finally {
      cardBusy = false;
      renderCards();
      renderExam();
    }
  }

  async function patchExamPrep(patch) {
    try {
      const res = await fetch(COMPANION_URL + "/exam-prep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json();
        if (companionState) companionState.examPrep = data.examPrep;
        renderExam();
      }
    } catch {}
  }

  document.getElementById("cards-refresh").addEventListener("click", () => void loadCompanionState());
  document.getElementById("mode-long-term").addEventListener("click", () => void patchExamPrep({ mode: "long-term" }));
  document.getElementById("mode-exam").addEventListener("click", () => void patchExamPrep({ mode: "exam" }));
  document.getElementById("pace-thorough").addEventListener("click", () => void patchExamPrep({ pace: "thorough" }));
  document.getElementById("pace-efficient").addEventListener("click", () => void patchExamPrep({ pace: "efficient" }));
  document.getElementById("pace-crash").addEventListener("click", () => void patchExamPrep({ pace: "crash-course" }));
  document.getElementById("session-back-btn").addEventListener("click", closeSessionReader);
  document.getElementById("session-refresh-btn").addEventListener("click", () => { if (activeSessionId) void openSessionReader(activeSessionId); });
  document.getElementById("session-reply-send").addEventListener("click", () => {
    const val = document.getElementById("session-reply-input").value.trim();
    if (!val) return;
    void sendMobileSessionAction({ replyText: val }, "session-reply-status", document.getElementById("session-reply-send"));
  });
  document.getElementById("session-note-save").addEventListener("click", () => {
    const val = document.getElementById("session-notes-input").value;
    void sendMobileSessionAction({ note: val }, "session-note-status", document.getElementById("session-note-save"));
  });
  void loadCompanionState();

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function addRow(name) {
    const row = document.createElement("div");
    row.className = "item";
    const left = document.createElement("span");
    left.textContent = name || "photo";
    const right = document.createElement("span");
    right.className = "muted";
    right.textContent = "Preparing...";
    row.append(left, right);
    list.prepend(row);
    return { row, status: right };
  }

  async function normalizeImage(file) {
    const highDetail = Boolean(hd && hd.checked);
    const maxDim = highDetail ? 2400 : 1600;
    const quality = highDetail ? 0.88 : 0.78;
    let bitmap = null;
    try {
      if (typeof createImageBitmap === "function") {
        try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
        catch { bitmap = await createImageBitmap(file); }
      }
    } catch { bitmap = null; }

    let width = bitmap ? bitmap.width : 0;
    let height = bitmap ? bitmap.height : 0;
    let imgEl = null;
    if (!bitmap) {
      try {
        const objUrl = URL.createObjectURL(file);
        try {
          imgEl = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = objUrl;
          });
          width = imgEl.naturalWidth || 0;
          height = imgEl.naturalHeight || 0;
        } finally {
          URL.revokeObjectURL(objUrl);
        }
      } catch {
        return file;
      }
    }

    const scale = Math.max(width, height) > maxDim ? maxDim / Math.max(width, height) : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      if (bitmap && typeof bitmap.close === "function") bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap || imgEl, 0, 0, w, h);
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob || file;
  }

  function sendPayload(payload, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", UPLOAD_URL, true);
      xhr.timeout = 45000;
      xhr.setRequestHeader("Content-Type", payload.type || "application/octet-stream");
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && ev.total > 0) {
          onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
        }
      };
      xhr.onload = () => {
        let json = {};
        try { json = JSON.parse(xhr.responseText || "{}"); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(json);
        else reject(new Error(json.error || ("HTTP " + xhr.status)));
      };
      xhr.onerror = () => reject(new Error("Network error"));
      xhr.ontimeout = () => reject(new Error("Upload timed out"));
      xhr.send(payload);
    });
  }

  async function uploadOne(file, entry) {
    try {
      const payload = await normalizeImage(file);
      const sizeLabel = formatBytes(payload.size);
      const t0 = Date.now();
      entry.status.textContent = "Uploading " + sizeLabel + "...";
      await sendPayload(payload, (pct) => {
        entry.status.textContent = pct >= 99
          ? ("Saving " + sizeLabel + "...")
          : ("Uploading " + sizeLabel + " · " + pct + "%");
      });
      const sec = Math.max(0.1, (Date.now() - t0) / 1000).toFixed(1);
      entry.status.className = "ok";
      entry.status.textContent = "Sent (" + sizeLabel + " · " + sec + "s)";
    } catch (err) {
      entry.status.className = "err";
      entry.status.textContent = err && err.message ? err.message : "Failed";
    }
  }

  function drainQueue() {
    while (inFlight < CONCURRENCY && pending.length > 0) {
      const job = pending.shift();
      inFlight++;
      uploadOne(job.file, job.entry).finally(() => {
        inFlight--;
        drainQueue();
      });
    }
  }

  function handleSelect(input) {
    const files = Array.from(input.files || []);
    input.value = "";
    for (const file of files) {
      pending.push({ file, entry: addRow(file.name) });
    }
    drainQueue();
  }

  cam.addEventListener("change", () => handleSelect(cam));
  lib.addEventListener("change", () => handleSelect(lib));
})();
</script>
</body>
</html>`;
}

async function readRequestBytes(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
	const declared = req.headers["content-length"];
	if (typeof declared === "string") {
		const len = Number.parseInt(declared, 10);
		if (Number.isFinite(len) && len > maxBytes) {
			throw new AttachmentError("Image exceeds the 25 MB limit", 413);
		}
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > maxBytes) throw new AttachmentError("Image exceeds the 25 MB limit", 413);
		chunks.push(buf);
	}
	return Buffer.concat(chunks, total);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	});
	res.end(payload);
}

function touchExpiry(session: InternalPhoneSession): void {
	session.expiresAt = Date.now() + SESSION_TTL_MS;
	if (session.timer) clearTimeout(session.timer);
	session.timer = setTimeout(() => {
		void closeSession(session);
	}, SESSION_TTL_MS);
	session.timer.unref?.();
}

async function closeSession(session: InternalPhoneSession | null): Promise<void> {
	if (!session || session.closed) return;
	session.closed = true;
	if (session.timer) {
		clearTimeout(session.timer);
		session.timer = null;
	}
	if (session.tunnelHandle) {
		try {
			session.tunnelHandle.close();
		} catch {
			// ignore tunnel shutdown errors
		}
		session.tunnelHandle = null;
	}
	if (getActiveSession() === session) setActiveSession(null);
	session.server.closeAllConnections?.();
	await new Promise<void>((resolve) => {
		session.server.close(() => resolve());
	});
}

function handlePhoneRequest(session: InternalPhoneSession, req: http.IncomingMessage, res: http.ServerResponse): void {
	let url: URL;
	try {
		url = new URL(req.url ?? "/", "http://127.0.0.1");
	} catch {
		sendJson(res, 400, { error: "Bad request URL" });
		return;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	let rawToken = "";
	try {
		rawToken = segments[1] ? decodeURIComponent(segments[1]) : "";
	} catch {
		res.writeHead(404);
		res.end("Not found");
		return;
	}
	if (segments[0] !== "p" || !tokenMatches(rawToken, session.tokenBuf)) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Invalid or expired upload link.");
		return;
	}

	if (req.method === "GET" && segments.length === 2) {
		const html = buildMobileHtml(`/p/${encodeURIComponent(session.token)}/upload`);
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(html);
		return;
	}

	if (req.method === "GET" && segments.length === 3 && segments[2] === "ping") {
		res.writeHead(200, {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		});
		res.end("ok");
		return;
	}

	if (req.method === "GET" && segments.length === 3 && segments[2] === "companion") {
		try {
			touchExpiry(session);
			const state = getMobileCompanionState({
				flashcardsFile: session.flashcardsFile,
				examPrepFile: session.examPrepFile,
				chatsDir: session.chatsDir,
			});
			sendJson(res, 200, state);
		} catch {
			sendJson(res, 500, { error: "Failed to load mobile companion state" });
		}
		return;
	}

	if (req.method === "POST" && segments.length === 4 && segments[2] === "companion" && segments[3] === "rate") {
		void (async () => {
			try {
				const bytes = await readRequestBytes(req, 64 * 1024);
				const body = JSON.parse(bytes.toString("utf8")) as {
					propositionId?: string;
					cueId?: string;
					rating?: number;
				};
				const result = rateMobileCompanionCard({
					propositionId: typeof body.propositionId === "string" ? body.propositionId : "",
					cueId: typeof body.cueId === "string" ? body.cueId : undefined,
					rating: body.rating as 1 | 2 | 3 | 4,
					flashcardsFile: session.flashcardsFile,
					examPrepFile: session.examPrepFile,
					chatsDir: session.chatsDir,
				});
				touchExpiry(session);
				sendJson(res, 200, result);
			} catch (err) {
				if (err instanceof MobileCompanionError) {
					sendJson(res, err.status, { error: err.message });
					return;
				}
				if (err instanceof AttachmentError) {
					sendJson(res, err.status, { error: err.message });
					return;
				}
				sendJson(res, 400, { error: "Invalid companion rating payload" });
			}
		})();
		return;
	}

	if (req.method === "GET" && segments.length === 4 && segments[2] === "companion" && segments[3] === "session") {
		try {
			const chatId = url.searchParams.get("chatId") ?? "";
			const detail = getMobileCompanionSessionDetail(chatId, {
				chatsDir: session.chatsDir,
			});
			touchExpiry(session);
			sendJson(res, 200, detail);
		} catch (err) {
			if (err instanceof MobileCompanionError) {
				sendJson(res, err.status, { error: err.message });
				return;
			}
			sendJson(res, 500, { error: "Failed to load session" });
		}
		return;
	}

	if (req.method === "POST" && segments.length === 4 && segments[2] === "companion" && segments[3] === "session") {
		void (async () => {
			try {
				const bytes = await readRequestBytes(req, 256 * 1024);
				const body = JSON.parse(bytes.toString("utf8")) as {
					chatId?: unknown;
					replyText?: unknown;
					note?: unknown;
				};
				const result = await appendMobileCompanionSessionNoteOrReply(
					{
						chatId: typeof body.chatId === "string" ? body.chatId : "",
						replyText: typeof body.replyText === "string" ? body.replyText : undefined,
						note: typeof body.note === "string" ? body.note : undefined,
					},
					{
						flashcardsFile: session.flashcardsFile,
						examPrepFile: session.examPrepFile,
						chatsDir: session.chatsDir,
					},
				);
				touchExpiry(session);
				sendJson(res, 200, result);
			} catch (err) {
				if (err instanceof MobileCompanionError) {
					sendJson(res, err.status, { error: err.message });
					return;
				}
				if (err instanceof AttachmentError) {
					sendJson(res, err.status, { error: err.message });
					return;
				}
				sendJson(res, 400, { error: "Invalid session action payload" });
			}
		})();
		return;
	}

	if (req.method === "POST" && segments.length === 4 && segments[2] === "companion" && segments[3] === "exam-prep") {
		void (async () => {
			try {
				const bytes = await readRequestBytes(req, 64 * 1024);
				const body = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
				const result = updateMobileCompanionExamPrep(body, {
					flashcardsFile: session.flashcardsFile,
					examPrepFile: session.examPrepFile,
					chatsDir: session.chatsDir,
				});
				touchExpiry(session);
				sendJson(res, 200, result);
			} catch (err) {
				if (err instanceof AttachmentError) {
					sendJson(res, err.status, { error: err.message });
					return;
				}
				sendJson(res, 400, { error: "Invalid exam prep payload" });
			}
		})();
		return;
	}

	if (req.method === "POST" && segments.length === 3 && segments[2] === "upload") {
		void (async () => {
			try {
				const bytes = await readRequestBytes(req, MAX_ATTACHMENT_IMAGE_BYTES);
				const saved = saveAttachmentImage(bytes, {
					prefix: "phone",
					attachmentsDir: session.attachmentsDir,
				});
				const entry: PhoneUploadEntry = {
					...saved,
					index: session.uploads.length,
					receivedAt: Date.now(),
				};
				session.uploads.push(entry);
				touchExpiry(session);
				sendJson(res, 200, {
					ok: true,
					filename: entry.filename,
					mimeType: entry.mimeType,
					size: entry.size,
				});
			} catch (err) {
				if (err instanceof AttachmentError) {
					sendJson(res, err.status, { error: err.message });
					return;
				}
				sendJson(res, 500, { error: "Failed to save image" });
			}
		})();
		return;
	}

	res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	res.end("Not found");
}

export interface CreatePhoneSessionOptions {
	host?: string;
	attachmentsDir?: string;
	flashcardsFile?: string;
	examPrepFile?: string;
	chatsDir?: string;
	interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
	/** Open a public HTTPS reverse tunnel (`trycloudflare.com` / `localhost.run`) so phones work off-Wi-Fi. */
	enableTunnel?: boolean;
	/** Force restarting the reusable standby tunnel instead of keeping the warm connection. */
	refreshTunnel?: boolean;
	tunnelSpawner?: PhoneTunnelSpawner;
}

/** Start an ephemeral tokenized LAN HTTP server for phone camera uploads (closes any prior session). */
export async function createPhoneUploadSession(options: CreatePhoneSessionOptions = {}): Promise<PhoneUploadSessionInfo> {
	const existing = getActiveSession();
	if (existing) await closeSession(existing);

	const id = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(18).toString("base64url");
	const tokenBuf = Buffer.from(token, "utf8");
	const addresses = rankLanAddresses(options.interfaces);
	const defaultAddress = addresses[0]?.address ?? null;
	const enableTunnel = options.enableTunnel ?? false;

	const session: InternalPhoneSession = {
		id,
		token,
		tokenBuf,
		port: 0,
		addresses,
		defaultAddress,
		expiresAt: Date.now() + SESSION_TTL_MS,
		uploads: [],
		attachmentsDir: options.attachmentsDir,
		flashcardsFile: options.flashcardsFile,
		examPrepFile: options.examPrepFile,
		chatsDir: options.chatsDir,
		server: null as unknown as http.Server,
		timer: null,
		closed: false,
		tunnelStatus: enableTunnel ? "starting" : "off",
		tunnelUrl: null,
		tunnelError: null,
		tunnelHandle: null,
		usesStandbyTunnel: false,
	};

	const server = http.createServer((req, res) => {
		handlePhoneRequest(session, req, res);
	});
	server.requestTimeout = 60_000;
	server.headersTimeout = 20_000;
	server.on("clientError", (_err, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	});
	session.server = server;

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			server.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, options.host ?? "0.0.0.0");
	});

	const addr = server.address();
	if (!addr || typeof addr === "string") {
		await closeSession(session);
		throw new Error("Failed to bind phone upload listener port");
	}
	session.port = addr.port;
	setActiveSession(session);
	touchExpiry(session);

	if (enableTunnel) {
		if (options.tunnelSpawner) {
			const spawner = options.tunnelSpawner;
			const pingPath = `/p/${encodeURIComponent(session.token)}/ping`;
			try {
				const handle = spawner(session.port, {
					pingPath,
					onReady: (url) => {
						if (session.closed || getActiveSession() !== session) return;
						session.tunnelStatus = "ready";
						session.tunnelUrl = url;
						session.tunnelError = null;
					},
					onError: (message) => {
						if (session.closed || getActiveSession() !== session) return;
						session.tunnelStatus = "error";
						session.tunnelUrl = null;
						session.tunnelError = message;
					},
				});
				if (session.closed || getActiveSession() !== session) {
					try {
						handle.close();
					} catch {
						// ignore
					}
				} else {
					session.tunnelHandle = handle;
				}
			} catch (err) {
				session.tunnelStatus = "error";
				session.tunnelUrl = null;
				session.tunnelError = err instanceof Error ? err.message : "Failed to start cross-network tunnel";
			}
		} else {
			try {
				session.usesStandbyTunnel = true;
				const standby = await ensureStandbyTunnel({ forceRestart: Boolean(options.refreshTunnel) });
				if (!session.closed && getActiveSession() === session) {
					session.tunnelStatus = standby.status;
					session.tunnelUrl = standby.url;
					session.tunnelError = standby.error;
				}
			} catch (err) {
				session.usesStandbyTunnel = false;
				session.tunnelStatus = "error";
				session.tunnelUrl = null;
				session.tunnelError = err instanceof Error ? err.message : "Failed to start cross-network tunnel";
			}
		}
	}

	return {
		sessionId: session.id,
		token: session.token,
		port: session.port,
		addresses: session.addresses,
		defaultAddress: session.defaultAddress,
		expiresAt: session.expiresAt,
		tunnelStatus: session.tunnelStatus,
		tunnelUrl: session.tunnelUrl,
		tunnelError: session.tunnelError,
	};
}

export function pollPhoneUploadSession(sessionId: string, since = 0): PhoneUploadPollResponse {
	const session = getActiveSession();
	if (!session || session.closed || session.id !== sessionId) {
		return {
			active: false,
			expiresAt: 0,
			uploads: [],
			nextIndex: since,
			tunnelStatus: "off",
			tunnelUrl: null,
			tunnelError: null,
		};
	}
	if (session.usesStandbyTunnel) {
		const standby = getStandbyTunnel();
		session.tunnelStatus = standby.status;
		session.tunnelUrl = standby.url;
		session.tunnelError = standby.error;
	}
	const start = Number.isFinite(since) && since > 0 ? Math.min(Math.floor(since), session.uploads.length) : 0;
	const uploads = session.uploads.slice(start);
	return {
		active: true,
		expiresAt: session.expiresAt,
		uploads,
		nextIndex: session.uploads.length,
		tunnelStatus: session.tunnelStatus,
		tunnelUrl: session.tunnelUrl,
		tunnelError: session.tunnelError,
	};
}

export async function closePhoneUploadSession(sessionId?: string | null): Promise<boolean> {
	const session = getActiveSession();
	if (!session) return false;
	if (sessionId && session.id !== sessionId) return false;
	await closeSession(session);
	return true;
}

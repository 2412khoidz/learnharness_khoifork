import crypto from "node:crypto";
import http from "node:http";
import type os from "node:os";
import {
	buildWebShareLanUrl,
	buildWebShareTunnelUrl,
	type LanAddressCandidate,
	type WebShareSessionInfo,
	type WebShareTunnelStatus,
} from "../core/index.ts";
import {
	defaultPhoneTunnelSpawner,
	rankLanAddresses,
	type PhoneTunnelSpawner,
} from "./phone-upload.ts";

export const WEB_SHARE_TTL_MS = 12 * 60 * 60 * 1000;
export const WEB_SHARE_COOKIE = "lh_web_share";

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export interface StartWebShareOptions {
	targetPort: number;
	refresh?: boolean;
	tunnel?: boolean;
	ttlMs?: number;
	desktopApiSecret?: string;
	tunnelSpawner?: PhoneTunnelSpawner;
	interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

interface InternalWebShareSession {
	id: string;
	pairToken: string;
	cookieSecret: string;
	probeToken: string;
	targetPort: number;
	desktopApiSecret: string | null;
	server: http.Server;
	port: number;
	addresses: LanAddressCandidate[];
	recommendedAddress: string | null;
	tunnelEnabled: boolean;
	tunnelSpawner: PhoneTunnelSpawner;
	tunnelStatus: WebShareTunnelStatus;
	tunnelUrl: string | null;
	tunnelError: string | null;
	tunnelHandle: { close: () => void } | null;
	tunnelGeneration: number;
	expiresAt: number;
	ttlMs: number;
	lastClientAt: number | null;
	expiryTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
}

interface GlobalWebShareState {
	session: InternalWebShareSession | null;
	hooksAttached: boolean;
}

const GLOBAL_KEY = Symbol.for("chronoharness.webShare.v1");

function getGlobalState(): GlobalWebShareState {
	const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: GlobalWebShareState };
	if (!g[GLOBAL_KEY]) {
		g[GLOBAL_KEY] = { session: null, hooksAttached: false };
	}
	if (!g[GLOBAL_KEY].hooksAttached) {
		g[GLOBAL_KEY].hooksAttached = true;
		const cleanup = () => {
			teardownSync();
		};
		process.once("exit", cleanup);
		process.once("SIGINT", cleanup);
		process.once("SIGTERM", cleanup);
	}
	return g[GLOBAL_KEY];
}

function timingSafeEqualStr(a: string, b: string): boolean {
	const aBuf = Buffer.from(a, "utf8");
	const bBuf = Buffer.from(b, "utf8");
	if (aBuf.length !== bBuf.length) return false;
	return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseAndStripShareCookie(cookieHeader: string | undefined): {
	shareCookie: string | null;
	strippedHeader: string | undefined;
} {
	if (!cookieHeader || !cookieHeader.trim()) {
		return { shareCookie: null, strippedHeader: undefined };
	}
	let shareCookie: string | null = null;
	const kept: string[] = [];
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 0) {
			kept.push(trimmed);
			continue;
		}
		const name = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		if (name === WEB_SHARE_COOKIE) {
			try {
				shareCookie = decodeURIComponent(value);
			} catch {
				shareCookie = value;
			}
		} else {
			kept.push(trimmed);
		}
	}
	return {
		shareCookie,
		strippedHeader: kept.length > 0 ? kept.join("; ") : undefined,
	};
}

function isHttpsRequest(req: http.IncomingMessage): boolean {
	const xfp = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
	const cfv = String(req.headers["cf-visitor"] ?? "").toLowerCase();
	const hostHdr = String(req.headers.host ?? "").toLowerCase();
	return (
		xfp.includes("https") ||
		cfv.includes("https") ||
		hostHdr.endsWith(".trycloudflare.com") ||
		hostHdr.endsWith(".lhr.life")
	);
}

function sendHtml(res: http.ServerResponse, status: number, title: string, message: string, extraHeaders?: Record<string, string>) {
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f3ec; color: #26231d; margin: 0; padding: 32px 16px; display: flex; justify-content: center; }
  .card { max-width: 440px; width: 100%; background: #fff; border: 1px solid #ddd6c9; border-radius: 14px; padding: 24px; box-shadow: 0 4px 16px rgba(0,0,0,0.06); }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; line-height: 1.5; color: #5c564c; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		...(extraHeaders ?? {}),
	});
	res.end(body);
}

function sendJsonError(res: http.ServerResponse, status: number, error: string) {
	const body = JSON.stringify({ error });
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(Buffer.byteLength(body)),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function rewriteReferer(referer: string | string[] | undefined, targetPort: number): string | undefined {
	const raw = Array.isArray(referer) ? referer[0] : referer;
	if (!raw) return undefined;
	try {
		const u = new URL(raw);
		return `http://127.0.0.1:${targetPort}${u.pathname}${u.search}`;
	} catch {
		return undefined;
	}
}

function rewriteRedirectLocation(location: string, targetPort: number): string {
	const localOriginRe = new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost):${targetPort}(/.*)?$`, "i");
	const match = localOriginRe.exec(location);
	if (!match) return location;
	return match[1] || "/";
}

function forwardToUpstream(
	session: InternalWebShareSession,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	strippedCookieHeader: string | undefined,
) {
	const outHeaders: http.OutgoingHttpHeaders = {};
	for (const [key, val] of Object.entries(req.headers)) {
		const lower = key.toLowerCase();
		if (
			HOP_BY_HOP_HEADERS.has(lower) ||
			lower === "cookie" ||
			lower === "x-learnharness-desktop" ||
			lower === "x-lh-web-share-remote" ||
			lower === "host"
		) {
			continue;
		}
		if (val !== undefined) outHeaders[lower] = val;
	}
	if (strippedCookieHeader) outHeaders["cookie"] = strippedCookieHeader;
	outHeaders["host"] = `127.0.0.1:${session.targetPort}`;
	if (req.headers.origin !== undefined) {
		outHeaders["origin"] = `http://127.0.0.1:${session.targetPort}`;
	}
	const rewrittenRef = rewriteReferer(req.headers.referer, session.targetPort);
	if (rewrittenRef) outHeaders["referer"] = rewrittenRef;
	else delete outHeaders["referer"];
	if (req.headers["sec-fetch-site"] !== undefined) {
		outHeaders["sec-fetch-site"] = "same-origin";
	}
	if (session.desktopApiSecret) {
		outHeaders["x-learnharness-desktop"] = session.desktopApiSecret;
	}
	outHeaders["x-lh-web-share-remote"] = "1";

	const upstreamReq = http.request(
		{
			hostname: "127.0.0.1",
			port: session.targetPort,
			method: req.method,
			path: req.url ?? "/",
			headers: outHeaders,
		},
		(upstreamRes) => {
			const resHeaders: http.OutgoingHttpHeaders = {};
			for (const [key, val] of Object.entries(upstreamRes.headers)) {
				const lower = key.toLowerCase();
				if (HOP_BY_HOP_HEADERS.has(lower)) continue;
				if (val !== undefined) resHeaders[lower] = val;
			}
			if (typeof resHeaders.location === "string") {
				resHeaders.location = rewriteRedirectLocation(resHeaders.location, session.targetPort);
			}
			const ctRaw = resHeaders["content-type"];
			const ctStr = Array.isArray(ctRaw) ? ctRaw.join(",") : String(ctRaw ?? "");
			if (/text\/event-stream/i.test(ctStr)) {
				resHeaders["cache-control"] = "no-cache, no-transform";
				resHeaders["x-accel-buffering"] = "no";
			}
			res.writeHead(upstreamRes.statusCode ?? 502, resHeaders);
			res.flushHeaders?.();
			upstreamRes.pipe(res);
		},
	);

	upstreamReq.setTimeout(0);
	upstreamReq.on("error", () => {
		if (!res.headersSent) {
			if ((req.url ?? "/").startsWith("/api")) {
				sendJsonError(res, 502, "ChronoHarness host app is unreachable.");
			} else {
				sendHtml(res, 502, "Host Unavailable", "ChronoHarness could not be reached on the host computer.");
			}
		} else if (!res.destroyed) {
			res.destroy();
		}
	});

	res.on("close", () => {
		if (!res.writableEnded) {
			upstreamReq.destroy();
		}
	});
	req.on("aborted", () => {
		upstreamReq.destroy();
	});

	req.pipe(upstreamReq);
}

function handleProxyRequest(
	session: InternalWebShareSession,
	req: http.IncomingMessage,
	res: http.ServerResponse,
) {
	if (session.closed || session.expiresAt <= Date.now()) {
		if ((req.url ?? "/").startsWith("/api")) {
			sendJsonError(res, 410, "ChronoHarness Web Share session expired.");
		} else {
			sendHtml(res, 410, "Share Link Expired", "This ChronoHarness share session has expired. Generate a fresh link on the host computer.");
		}
		return;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
	} catch {
		sendJsonError(res, 400, "Malformed URL");
		return;
	}

	const probePath = `/__probe/${encodeURIComponent(session.probeToken)}`;
	if ((req.method === "GET" || req.method === "HEAD") && parsedUrl.pathname === probePath) {
		res.writeHead(200, {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(req.method === "HEAD" ? undefined : "ok");
		return;
	}

	if (req.method === "GET" && parsedUrl.pathname === "/__share/logout") {
		const isHttps = isHttpsRequest(req);
		sendHtml(
			res,
			200,
			"Signed Out",
			"Your ChronoHarness Web Share browser session has been signed out. Re-open the share link from the host to reconnect.",
			{
				"Set-Cookie": `${WEB_SHARE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? "; Secure" : ""}`,
			},
		);
		return;
	}

	if (req.method === "GET" && parsedUrl.pathname.startsWith("/__share/")) {
		const rawSegment = parsedUrl.pathname.slice("/__share/".length);
		let supplied = rawSegment;
		try {
			supplied = decodeURIComponent(rawSegment);
		} catch {
			// keep raw segment so timingSafeEqualStr safely rejects it
		}
		if (!rawSegment || rawSegment.includes("/") || !timingSafeEqualStr(supplied, session.pairToken)) {
			sendHtml(res, 403, "Invalid Share Link", "This ChronoHarness share link is invalid or has been revoked by the host.");
			return;
		}
		const maxAge = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
		const isHttps = isHttpsRequest(req);
		const cookieAttrs = [
			`${WEB_SHARE_COOKIE}=${session.cookieSecret}`,
			"Path=/",
			"HttpOnly",
			"SameSite=Lax",
			`Max-Age=${maxAge}`,
			...(isHttps ? ["Secure"] : []),
		].join("; ");
		session.lastClientAt = Date.now();
		res.writeHead(302, {
			Location: "/",
			"Set-Cookie": cookieAttrs,
			"Cache-Control": "no-store",
		});
		res.end();
		return;
	}

	const { shareCookie, strippedHeader } = parseAndStripShareCookie(req.headers.cookie);
	if (!shareCookie || !timingSafeEqualStr(shareCookie, session.cookieSecret)) {
		if (parsedUrl.pathname.startsWith("/api")) {
			sendJsonError(res, 403, "ChronoHarness Web Share authentication required.");
		} else {
			sendHtml(res, 403, "Authentication Required", "Please open the ChronoHarness share link or scan the QR code from the host computer.");
		}
		return;
	}

	session.lastClientAt = Date.now();
	forwardToUpstream(session, req, res, strippedHeader);
}

function listenOnHost(server: http.Server, host: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const onError = (err: Error) => {
			server.off("listening", onListening);
			reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to inspect Web Share proxy socket address"));
				return;
			}
			resolve(addr.port);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(0, host);
	});
}

async function bindProxyServer(sessionRef: { current: InternalWebShareSession | null }): Promise<{ server: http.Server; port: number }> {
	const server = http.createServer((req, res) => {
		const session = sessionRef.current;
		if (!session) {
			sendJsonError(res, 404, "No active Web Share session.");
			return;
		}
		handleProxyRequest(session, req, res);
	});
	server.requestTimeout = 0;
	server.keepAliveTimeout = 65_000;
	server.headersTimeout = 30_000;
	server.on("clientError", (_err, socket) => {
		if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	});
	server.on("upgrade", (_req, socket) => {
		socket.destroy();
	});

	let port: number;
	try {
		port = await listenOnHost(server, "0.0.0.0");
	} catch {
		port = await listenOnHost(server, "127.0.0.1");
	}
	server.unref?.();
	return { server, port };
}

function launchTunnelForSession(session: InternalWebShareSession): void {
	if (!session.tunnelEnabled || session.closed) return;
	if (session.tunnelHandle) {
		try {
			session.tunnelHandle.close();
		} catch {
			// ignore tunnel shutdown error
		}
		session.tunnelHandle = null;
	}
	const gen = ++session.tunnelGeneration;
	session.tunnelStatus = "starting";
	session.tunnelUrl = null;
	session.tunnelError = null;
	const pingPath = `/__probe/${encodeURIComponent(session.probeToken)}`;
	try {
		const handle = session.tunnelSpawner(session.port, {
			pingPath,
			onReady: (url) => {
				if (session.closed || session.tunnelGeneration !== gen) return;
				session.tunnelStatus = "ready";
				session.tunnelUrl = url;
				session.tunnelError = null;
			},
			onError: (msg) => {
				if (session.closed || session.tunnelGeneration !== gen) return;
				session.tunnelStatus = "error";
				session.tunnelUrl = null;
				session.tunnelError = msg;
			},
		});
		if (session.closed || session.tunnelGeneration !== gen) {
			try {
				handle.close();
			} catch {
				// ignore
			}
		} else {
			session.tunnelHandle = handle;
		}
	} catch (err) {
		if (!session.closed && session.tunnelGeneration === gen) {
			session.tunnelStatus = "error";
			session.tunnelUrl = null;
			session.tunnelError = err instanceof Error ? err.message : "Failed to start Web Share tunnel";
		}
	}
}

function teardownSync() {
	const state = getGlobalState();
	const session = state.session;
	state.session = null;
	if (!session) return;
	session.closed = true;
	if (session.expiryTimer) {
		clearTimeout(session.expiryTimer);
		session.expiryTimer = null;
	}
	if (session.tunnelHandle) {
		try {
			session.tunnelHandle.close();
		} catch {
			// ignore
		}
		session.tunnelHandle = null;
	}
	try {
		session.server.closeAllConnections?.();
		session.server.close();
	} catch {
		// ignore
	}
}

function toSessionInfo(session: InternalWebShareSession | null): WebShareSessionInfo {
	if (!session || session.closed || session.expiresAt <= Date.now()) {
		return {
			active: false,
			tunnelStatus: "idle",
			tunnelUrl: null,
			tunnelError: null,
			shareUrl: null,
			lanShareUrl: null,
		};
	}
	const lanShareUrl = session.recommendedAddress
		? buildWebShareLanUrl(session.recommendedAddress, session.port, session.pairToken)
		: null;
	const shareUrl = session.tunnelUrl
		? buildWebShareTunnelUrl(session.tunnelUrl, session.pairToken)
		: lanShareUrl;
	return {
		active: true,
		sessionId: session.id,
		token: session.pairToken,
		port: session.port,
		addresses: session.addresses,
		recommendedAddress: session.recommendedAddress,
		tunnelStatus: session.tunnelStatus,
		tunnelUrl: session.tunnelUrl,
		tunnelError: session.tunnelError,
		shareUrl,
		lanShareUrl,
		expiresAt: session.expiresAt,
		lastClientAt: session.lastClientAt,
	};
}

/** Return the current host Web Share session status (or inactive status if closed/expired). */
export function getWebShareStatus(): WebShareSessionInfo {
	const state = getGlobalState();
	const session = state.session;
	if (session && (session.closed || session.expiresAt <= Date.now())) {
		teardownSync();
		return toSessionInfo(null);
	}
	return toSessionInfo(session);
}

/** Close any active Web Share proxy server and public HTTPS tunnel immediately. */
export async function closeWebShareSession(): Promise<boolean> {
	const state = getGlobalState();
	const session = state.session;
	state.session = null;
	if (!session) return false;
	session.closed = true;
	if (session.expiryTimer) {
		clearTimeout(session.expiryTimer);
		session.expiryTimer = null;
	}
	if (session.tunnelHandle) {
		try {
			session.tunnelHandle.close();
		} catch {
			// ignore
		}
		session.tunnelHandle = null;
	}
	await new Promise<void>((resolve) => {
		try {
			session.server.closeAllConnections?.();
			session.server.close(() => resolve());
		} catch {
			resolve();
		}
	});
	return true;
}

/** Start (or refresh/reuse) the authenticated Web Share proxy + optional HTTPS tunnel. */
export async function startWebShareSession(options: StartWebShareOptions): Promise<WebShareSessionInfo> {
	const state = getGlobalState();
	const existing = state.session;
	const wantTunnel = options.tunnel !== false;
	const ttlMs = Math.max(5_000, options.ttlMs ?? WEB_SHARE_TTL_MS);

	if (
		existing &&
		!existing.closed &&
		existing.expiresAt > Date.now() &&
		existing.targetPort === options.targetPort &&
		!options.refresh
	) {
		existing.addresses = rankLanAddresses(options.interfaces);
		existing.recommendedAddress =
			existing.addresses.find((a) => a.recommended)?.address ?? existing.addresses[0]?.address ?? null;
		if (wantTunnel && !existing.tunnelEnabled) {
			existing.tunnelEnabled = true;
		}
		if (options.tunnelSpawner) {
			existing.tunnelSpawner = options.tunnelSpawner;
		}
		if (wantTunnel && (existing.tunnelStatus === "error" || existing.tunnelStatus === "idle")) {
			launchTunnelForSession(existing);
		}
		return toSessionInfo(existing);
	}

	await closeWebShareSession();

	const sessionRef: { current: InternalWebShareSession | null } = { current: null };
	const { server, port } = await bindProxyServer(sessionRef);
	const addresses = rankLanAddresses(options.interfaces);
	const recommendedAddress =
		addresses.find((a) => a.recommended)?.address ?? addresses[0]?.address ?? null;

	const session: InternalWebShareSession = {
		id: crypto.randomUUID(),
		pairToken: crypto.randomBytes(24).toString("base64url"),
		cookieSecret: crypto.randomBytes(32).toString("base64url"),
		probeToken: crypto.randomBytes(12).toString("base64url"),
		targetPort: options.targetPort,
		desktopApiSecret: options.desktopApiSecret ?? process.env.LH_DESKTOP_API_SECRET ?? null,
		server,
		port,
		addresses,
		recommendedAddress,
		tunnelEnabled: wantTunnel,
		tunnelSpawner: options.tunnelSpawner ?? defaultPhoneTunnelSpawner,
		tunnelStatus: wantTunnel ? "starting" : "idle",
		tunnelUrl: null,
		tunnelError: null,
		tunnelHandle: null,
		tunnelGeneration: 0,
		expiresAt: Date.now() + ttlMs,
		ttlMs,
		lastClientAt: null,
		expiryTimer: null,
		closed: false,
	};

	sessionRef.current = session;
	session.expiryTimer = setTimeout(() => {
		if (getGlobalState().session?.id === session.id) {
			teardownSync();
		}
	}, ttlMs);
	session.expiryTimer.unref?.();

	state.session = session;
	if (wantTunnel) {
		launchTunnelForSession(session);
	}

	return toSessionInfo(session);
}

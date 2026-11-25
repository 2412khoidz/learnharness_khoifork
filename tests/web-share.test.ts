import assert from "node:assert/strict";
import http from "node:http";
import { after, before, it } from "node:test";
import {
	closeWebShareSession,
	getWebShareStatus,
	startWebShareSession,
	WEB_SHARE_COOKIE,
} from "../src/server/web-share.ts";

let upstreamServer: http.Server;
let upstreamPort = 0;
let upstreamHitCount = 0;
let lastUpstreamRequest: {
	url: string;
	method: string;
	headers: http.IncomingHttpHeaders;
	body: string;
} | null = null;

before(async () => {
	upstreamServer = http.createServer((req, res) => {
		upstreamHitCount++;
		const url = req.url ?? "/";
		if (url === "/api/events") {
			lastUpstreamRequest = { url, method: req.method ?? "GET", headers: req.headers, body: "" };
			res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
			res.write("data: hello\n\n");
			const timer = setTimeout(() => {
				res.write("data: world\n\n");
				res.end();
			}, 40);
			timer.unref?.();
			return;
		}
		if (url === "/redirect-local") {
			res.writeHead(302, { Location: `http://127.0.0.1:${upstreamPort}/planner` });
			res.end();
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk as Buffer));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			lastUpstreamRequest = { url, method: req.method ?? "GET", headers: req.headers, body };
			if (url === "/api/echo") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						ok: true,
						body,
						desktopSecret: req.headers["x-learnharness-desktop"] ?? null,
						remoteMark: req.headers["x-lh-web-share-remote"] ?? null,
						host: req.headers.host ?? null,
						origin: req.headers.origin ?? null,
						cookie: req.headers.cookie ?? null,
					}),
				);
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end("<html><body>Full ChronoHarness Home</body></html>");
		});
	});
	await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", () => resolve()));
	const addr = upstreamServer.address();
	assert.ok(addr && typeof addr !== "string");
	upstreamPort = addr.port;
});

after(async () => {
	await closeWebShareSession();
	await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
});

it("enforces pairing authentication, injects loopback secrets safely, streams SSE, rewrites redirects, and revokes on refresh", async () => {
	let tunnelClosedCount = 0;
	let pingPath = "";
	const info = await startWebShareSession({
		targetPort: upstreamPort,
		desktopApiSecret: "super-secret-desktop-capability-string-0123456789abcdef0123456789abcdef",
		interfaces: {
			"Wi-Fi": [{ address: "192.168.1.55", netmask: "255.255.255.0", family: "IPv4", mac: "00:11:22:33:44:55", internal: false, cidr: "192.168.1.55/24" }],
		},
		tunnelSpawner: (port, cb) => {
			assert.ok(port > 0);
			assert.ok(cb.pingPath?.startsWith("/__probe/"));
			pingPath = cb.pingPath!;
			cb.onReady("https://demo-study.trycloudflare.com");
			return {
				close() {
					tunnelClosedCount++;
				},
			};
		},
	});

	assert.equal(info.active, true);
	assert.equal(info.tunnelStatus, "ready");
	assert.equal(info.tunnelUrl, "https://demo-study.trycloudflare.com");
	assert.equal(info.shareUrl, `https://demo-study.trycloudflare.com/__share/${encodeURIComponent(info.token!)}`);
	assert.equal(info.lanShareUrl, `http://192.168.1.55:${info.port}/__share/${encodeURIComponent(info.token!)}`);

	const base = `http://127.0.0.1:${info.port}`;
	const hitsBefore = upstreamHitCount;

	// 0. Probe path responds 200 "ok" without hitting upstream
	const probeRes = await fetch(`${base}${pingPath}`);
	assert.equal(probeRes.status, 200);
	assert.equal(await probeRes.text(), "ok");

	// 1. Unauthenticated requests must get 403 and NEVER reach upstream
	const unauthHome = await fetch(`${base}/`);
	assert.equal(unauthHome.status, 403);
	const unauthApi = await fetch(`${base}/api/echo`);
	assert.equal(unauthApi.status, 403);
	assert.equal(upstreamHitCount, hitsBefore, "unauthenticated requests must not hit upstream");

	// 2. Invalid pairing token gets 403
	const badPair = await fetch(`${base}/__share/wrong-token-value`);
	assert.equal(badPair.status, 403);

	// 3. Valid pairing link sets HttpOnly + Secure (on HTTPS proto) cookie and redirects to /
	const pairRes = await fetch(`${base}/__share/${encodeURIComponent(info.token!)}`, {
		headers: { "x-forwarded-proto": "https" },
		redirect: "manual",
	});
	assert.equal(pairRes.status, 302);
	assert.equal(pairRes.headers.get("location"), "/");
	const setCookie = pairRes.headers.get("set-cookie") ?? "";
	assert.ok(setCookie.includes(`${WEB_SHARE_COOKIE}=`));
	assert.ok(setCookie.includes("HttpOnly"));
	assert.ok(setCookie.includes("SameSite=Lax"));
	assert.ok(setCookie.includes("Secure"));

	const shareCookiePair = setCookie.split(";")[0]!;

	// 4. Authenticated GET / and POST /api/echo proxy cleanly with loopback secret and stripped share cookie
	const homeRes = await fetch(`${base}/`, { headers: { cookie: shareCookiePair } });
	assert.equal(homeRes.status, 200);
	assert.match(await homeRes.text(), /Full ChronoHarness Home/);

	const echoRes = await fetch(`${base}/api/echo`, {
		method: "POST",
		headers: {
			cookie: `${shareCookiePair}; other_pref=1`,
			origin: "https://demo-study.trycloudflare.com",
			"sec-fetch-site": "same-origin",
			"x-learnharness-desktop": "attacker-spoofed-value",
		},
		body: JSON.stringify({ hello: "gf" }),
	});
	assert.equal(echoRes.status, 200);
	const echoJson = (await echoRes.json()) as Record<string, unknown>;
	assert.equal(echoJson.ok, true);
	assert.equal(echoJson.body, JSON.stringify({ hello: "gf" }));
	assert.equal(echoJson.desktopSecret, "super-secret-desktop-capability-string-0123456789abcdef0123456789abcdef");
	assert.equal(echoJson.remoteMark, "1");
	assert.equal(echoJson.host, `127.0.0.1:${upstreamPort}`);
	assert.equal(echoJson.origin, `http://127.0.0.1:${upstreamPort}`);
	assert.equal(echoJson.cookie, "other_pref=1", "share cookie stripped while preserving app cookies");
	assert.equal(lastUpstreamRequest?.headers["sec-fetch-site"], "same-origin");

	// 5. Redirect from localhost:targetPort rewrites to relative path
	const redirRes = await fetch(`${base}/redirect-local`, {
		headers: { cookie: shareCookiePair },
		redirect: "manual",
	});
	assert.equal(redirRes.status, 302);
	assert.equal(redirRes.headers.get("location"), "/planner");

	// 6. SSE stream passes through cleanly without buffering
	const sseRes = await fetch(`${base}/api/events`, { headers: { cookie: shareCookiePair } });
	assert.equal(sseRes.status, 200);
	assert.equal(sseRes.headers.get("x-accel-buffering"), "no");
	const sseText = await sseRes.text();
	assert.match(sseText, /data: hello/);
	assert.match(sseText, /data: world/);

	// 7. Refresh rotates secret & invalidates old cookie immediately
	const refreshed = await startWebShareSession({
		targetPort: upstreamPort,
		refresh: true,
		tunnel: false,
	});
	assert.equal(tunnelClosedCount, 1);
	assert.notEqual(refreshed.token, info.token);
	const staleRes = await fetch(`http://127.0.0.1:${refreshed.port}/`, {
		headers: { cookie: shareCookiePair },
	});
	assert.equal(staleRes.status, 403, "old cookie rejected after refresh");

	// 8. Logout clears cookie, and close shuts everything down cleanly
	const logoutRes = await fetch(`http://127.0.0.1:${refreshed.port}/__share/logout`);
	assert.equal(logoutRes.status, 200);
	assert.match(logoutRes.headers.get("set-cookie") ?? "", /Max-Age=0/);

	assert.equal(await closeWebShareSession(), true);
	assert.equal(getWebShareStatus().active, false);
});

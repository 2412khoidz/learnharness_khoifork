import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	buildPhoneTunnelUploadUrl,
	buildPhoneUploadUrl,
	encodeQrMatrix,
	extractClipboardImageFiles,
	qrSvgPath,
} from "../src/core/index.ts";
import {
	AttachmentError,
	closePhoneUploadSession,
	createPhoneUploadSession,
	pollPhoneUploadSession,
	rankLanAddresses,
	saveAttachmentImage,
	stopPhoneUploadTunnel,
	warmPhoneUploadTunnel,
	type PhoneTunnelSpawner,
} from "../src/server/index.ts";
import { POST as postAttachmentRoute } from "../app/api/attachments/route.ts";
import {
	DELETE as deletePhoneRoute,
	GET as getPhoneRoute,
	POST as postPhoneRoute,
} from "../app/api/attachments/phone/route.ts";
import { findInstalledCloudflared, resolveCloudflaredAsset } from "../src/server/tunnel-binary.ts";

// Minimal valid 1x1 transparent PNG.
const VALID_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);
// Minimal JPEG SOI + APP0 header bytes recognized by magic-byte sniffer.
const VALID_JPEG = Buffer.from([
	0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attach-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await closePhoneUploadSession();
	await stopPhoneUploadTunnel();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("QR matrix generator", () => {
	it("generates compliant finder patterns, timing patterns, dark module, and SVG paths across versions", () => {
		const shortQr = encodeQrMatrix("HELLO WORLD");
		assert.equal(shortQr.version, 1);
		assert.equal(shortQr.size, 21);
		// Top-left 7x7 finder corners and center must be dark; (size - 8, 8) dark module must be dark.
		const at = (m: typeof shortQr, r: number, c: number) => m.modules[r * m.size + c];
		assert.equal(at(shortQr, 0, 0), true);
		assert.equal(at(shortQr, 1, 1), false);
		assert.equal(at(shortQr, 3, 3), true);
		assert.equal(at(shortQr, shortQr.size - 8, 8), true);
		assert.equal(at(shortQr, 6, 8), true);
		assert.equal(at(shortQr, 6, 9), false);

		const svg = qrSvgPath(shortQr);
		assert.match(svg, /^M\d+,\d+h\d+v1h-\d+z/);

		const urlQr = encodeQrMatrix("http://192.168.1.42:54321/p/abcdef1234567890abcdef12");
		assert.equal(urlQr.version, 4);
		assert.equal(urlQr.size, 33);

		const maxQr = encodeQrMatrix("a".repeat(210));
		assert.equal(maxQr.version, 10);
		assert.equal(maxQr.size, 57);

		assert.throws(() => encodeQrMatrix("a".repeat(214)), /QR payload too long/);
	});
});

describe("clipboard and URL pure helpers", () => {
	it("builds clean phone URLs and extracts non-empty image Files only", () => {
		assert.equal(
			buildPhoneUploadUrl("192.168.1.25", 5001, "tok_123"),
			"http://192.168.1.25:5001/p/tok_123",
		);

		assert.deepEqual(extractClipboardImageFiles(null), []);
		const emptyMock = { items: undefined, files: undefined } as unknown as DataTransfer;
		assert.deepEqual(extractClipboardImageFiles(emptyMock), []);

		const pngFile = new File([VALID_PNG], "shot.png", { type: "image/png" });
		const emptyFile = new File([], "empty.png", { type: "image/png" });
		const txtFile = new File(["hello"], "note.txt", { type: "text/plain" });
		const transfer = {
			items: [
				{ kind: "file", type: "image/png", getAsFile: () => pngFile },
				{ kind: "file", type: "image/png", getAsFile: () => emptyFile },
				{ kind: "file", type: "text/plain", getAsFile: () => txtFile },
			] as unknown as DataTransferItemList,
			files: [pngFile, txtFile] as unknown as FileList,
		};
		assert.deepEqual(extractClipboardImageFiles(transfer), [pngFile]);
	});
});

describe("saveAttachmentImage", () => {
	it("validates magic bytes and writes safe image attachments to disk", () => {
		const dir = makeTempDir();
		const png = saveAttachmentImage(VALID_PNG, { prefix: "paste", attachmentsDir: dir });
		assert.equal(png.mimeType, "image/png");
		assert.match(png.filename, /^paste-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
		assert.equal(path.dirname(png.path), dir);
		assert.deepEqual(fs.readFileSync(png.path), VALID_PNG);

		const jpg = saveAttachmentImage(VALID_JPEG, { prefix: "phone", attachmentsDir: dir });
		assert.equal(jpg.mimeType, "image/jpeg");
		assert.match(jpg.filename, /^phone-.*\.jpg$/);

		assert.throws(() => saveAttachmentImage(Buffer.alloc(0), { attachmentsDir: dir }), (err: unknown) =>
			err instanceof AttachmentError && err.status === 400,
		);
		assert.throws(() => saveAttachmentImage(Buffer.from("<svg>not png</svg>"), { attachmentsDir: dir }), (err: unknown) =>
			err instanceof AttachmentError && err.status === 415,
		);
	});
});

describe("rankLanAddresses and phone upload HTTP server", () => {
	it("ranks real Wi-Fi/Ethernet adapters ahead of virtual/VPN NICs", () => {
		const ranked = rankLanAddresses({
			Loopback: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
			"vEthernet (WSL)": [{ address: "172.24.16.1", netmask: "255.255.240.0", family: "IPv4", mac: "00:15:5d:00:00:01", internal: false, cidr: "172.24.16.1/20" }],
			"VirtualBox Host-Only Network": [{ address: "192.168.56.1", netmask: "255.255.255.0", family: "IPv4", mac: "0a:00:27:00:00:00", internal: false, cidr: "192.168.56.1/24" }],
			Tailscale: [{ address: "100.80.1.2", netmask: "255.192.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.80.1.2/10" }],
			"APIPA": [{ address: "169.254.10.20", netmask: "255.255.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "169.254.10.20/16" }],
			"Wi-Fi": [{ address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.42/24" }],
		});
		assert.equal(ranked[0]?.address, "192.168.1.42");
		assert.equal(ranked[0]?.recommended, true);
		assert.ok(!ranked.some((c) => c.address.startsWith("127.") || c.address.startsWith("169.254.")));
	});

	it("serves tokenized camera HTML, rejects wrong tokens, saves valid images, and closes cleanly", async () => {
		const dir = makeTempDir();
		const session = await createPhoneUploadSession({ host: "127.0.0.1", attachmentsDir: dir });
		assert.ok(session.port > 0);

		const badRes = await fetch(`http://127.0.0.1:${session.port}/p/wrong-token`);
		assert.equal(badRes.status, 404);

		const pageRes = await fetch(`http://127.0.0.1:${session.port}/p/${session.token}`);
		assert.equal(pageRes.status, 200);
		const html = await pageRes.text();
		assert.match(html, /capture="environment"/);
		assert.match(html, /multiple/);
		assert.match(html, /id="hd"/);
		assert.match(html, /XMLHttpRequest/);
		assert.ok(!html.includes("https://"), "mobile upload page must stay 100% offline/self-contained");

		const pingRes = await fetch(`http://127.0.0.1:${session.port}/p/${session.token}/ping`);
		assert.equal(pingRes.status, 200);
		assert.equal(await pingRes.text(), "ok");

		const badUpload = await fetch(`http://127.0.0.1:${session.port}/p/${session.token}/upload`, {
			method: "POST",
			body: Buffer.from("not an image"),
		});
		assert.equal(badUpload.status, 415);

		const okUpload = await fetch(`http://127.0.0.1:${session.port}/p/${session.token}/upload`, {
			method: "POST",
			headers: { "Content-Type": "image/png" },
			body: VALID_PNG,
		});
		assert.equal(okUpload.status, 200);
		const uploadJson = await okUpload.json() as { ok: boolean; filename: string; mimeType: string };
		assert.equal(uploadJson.ok, true);
		assert.equal(uploadJson.mimeType, "image/png");

		const poll1 = pollPhoneUploadSession(session.sessionId, 0);
		assert.equal(poll1.active, true);
		assert.equal(poll1.uploads.length, 1);
		assert.equal(poll1.nextIndex, 1);
		assert.equal(fs.existsSync(poll1.uploads[0]!.path), true);

		const poll2 = pollPhoneUploadSession(session.sessionId, poll1.nextIndex);
		assert.equal(poll2.uploads.length, 0);
		assert.equal(poll2.nextIndex, 1);

		assert.equal(await closePhoneUploadSession(session.sessionId), true);
		assert.equal(pollPhoneUploadSession(session.sessionId, 0).active, false);
		await assert.rejects(() => fetch(`http://127.0.0.1:${session.port}/p/${session.token}`));
	});
});

describe("attachment Next API route handlers", () => {
	it("rejects invalid /api/attachments payload and manages /api/attachments/phone lifecycle", async () => {
		const badAttach = await postAttachmentRoute(new Request("http://localhost/api/attachments", {
			method: "POST",
			body: Buffer.from("plain text"),
		}));
		assert.equal(badAttach.status, 415);

		const startRes = await postPhoneRoute();
		assert.equal(startRes.status, 200);
		const session = await startRes.json() as { sessionId: string; token: string; port: number };
		assert.ok(session.sessionId && session.token && session.port > 0);

		const pollRes = await getPhoneRoute(new Request(`http://localhost/api/attachments/phone?sessionId=${session.sessionId}&since=0`));
		assert.equal(pollRes.status, 200);
		const pollJson = await pollRes.json() as { active: boolean; uploads: unknown[] };
		assert.equal(pollJson.active, true);
		assert.deepEqual(pollJson.uploads, []);

		const delRes = await deletePhoneRoute(new Request(`http://localhost/api/attachments/phone?sessionId=${session.sessionId}`, { method: "DELETE" }));
		assert.equal(delRes.status, 200);
		const delJson = await delRes.json() as { closed: boolean };
		assert.equal(delJson.closed, true);
	});
});


describe("phone upload cross-network tunnel support", () => {
	it("builds clean HTTPS tunnel URLs", () => {
		assert.equal(
			buildPhoneTunnelUploadUrl("https://abc123.lhr.life/", "tok+1/2"),
			"https://abc123.lhr.life/p/tok%2B1%2F2",
		);
	});

	it("manages tunnel spawner starting -> ready -> error transitions and closes tunnel handle on teardown", async () => {
		let capturedPort = 0;
		let callbacksRef: Parameters<PhoneTunnelSpawner>[1] | null = null;
		let tunnelClosed = false;
		const spawner: PhoneTunnelSpawner = (port, callbacks) => {
			capturedPort = port;
			callbacksRef = callbacks;
			return {
				close() {
					tunnelClosed = true;
				},
			};
		};

		const session = await createPhoneUploadSession({
			host: "127.0.0.1",
			enableTunnel: true,
			tunnelSpawner: spawner,
		});
		assert.equal(capturedPort, session.port);
		assert.equal(session.tunnelStatus, "starting");
		assert.equal(session.tunnelUrl, null);

		callbacksRef!.onReady("https://demo-test.lhr.life");
		const readyPoll = pollPhoneUploadSession(session.sessionId, 0);
		assert.equal(readyPoll.tunnelStatus, "ready");
		assert.equal(readyPoll.tunnelUrl, "https://demo-test.lhr.life");
		assert.equal(readyPoll.tunnelError, null);

		callbacksRef!.onError("Tunnel dropped");
		const errPoll = pollPhoneUploadSession(session.sessionId, 0);
		assert.equal(errPoll.tunnelStatus, "error");
		assert.equal(errPoll.tunnelUrl, null);
		assert.equal(errPoll.tunnelError, "Tunnel dropped");

		assert.equal(await closePhoneUploadSession(session.sessionId), true);
		assert.equal(tunnelClosed, true);
	});

	it("keeps tunnel off under NODE_ENV=test route calls", async () => {
		const startRes = await postPhoneRoute();
		assert.equal(startRes.status, 200);
		const session = await startRes.json() as { sessionId: string; tunnelStatus?: string };
		assert.equal(session.tunnelStatus, "off");
		await deletePhoneRoute(new Request(`http://localhost/api/attachments/phone?sessionId=${session.sessionId}`, { method: "DELETE" }));
	});

	it("passes pingPath to tunnel spawner and resolves/locates cloudflared binary", async () => {
		let capturedPingPath: string | undefined;
		const session = await createPhoneUploadSession({
			host: "127.0.0.1",
			enableTunnel: true,
			tunnelSpawner: (_port, callbacks) => {
				capturedPingPath = callbacks.pingPath;
				callbacks.onReady("https://fast-demo.trycloudflare.com");
				return { close() {} };
			},
		});
		assert.equal(capturedPingPath, `/p/${encodeURIComponent(session.token)}/ping`);
		assert.equal(session.tunnelStatus, "ready");
		assert.equal(session.tunnelUrl, "https://fast-demo.trycloudflare.com");
		await closePhoneUploadSession(session.sessionId);

		assert.deepEqual(resolveCloudflaredAsset("win32", "x64"), {
			assetName: "cloudflared-windows-amd64.exe",
			binaryName: "cloudflared.exe",
			archive: "none",
		});
		assert.deepEqual(resolveCloudflaredAsset("darwin", "arm64"), {
			assetName: "cloudflared-darwin-arm64.tgz",
			binaryName: "cloudflared",
			archive: "tgz",
		});
		assert.equal(resolveCloudflaredAsset("freebsd", "x64"), null);

		const tmpBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-find-test-"));
		try {
			const binName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
			const binFile = path.join(tmpBinDir, binName);
			fs.writeFileSync(binFile, "stub");
			assert.equal(findInstalledCloudflared(tmpBinDir, { PATH: "" }), binFile);
		} finally {
			fs.rmSync(tmpBinDir, { recursive: true, force: true });
		}
	});

	it("pre-warms standby tunnel gateway safely and reuses it across sessions", async () => {
		let gatewayPort = 0;
		let probePath = "";
		let spawnCount = 0;
		await warmPhoneUploadTunnel({
			tunnelSpawner: (port, callbacks) => {
				spawnCount++;
				gatewayPort = port;
				probePath = callbacks.pingPath ?? "";
				callbacks.onReady("https://warm-demo.trycloudflare.com");
				return { close() {} };
			},
		});
		assert.equal(spawnCount, 1);
		assert.ok(gatewayPort > 0);
		assert.match(probePath, /^\/__probe\//);

		const probeRes = await fetch(`http://127.0.0.1:${gatewayPort}${probePath}`);
		assert.equal(probeRes.status, 200);
		assert.equal(await probeRes.text(), "ok");

		const noSessionRes = await fetch(`http://127.0.0.1:${gatewayPort}/p/fake-token`);
		assert.equal(noSessionRes.status, 404);

		// Creating a session reuses the warm standby tunnel immediately and rejects old tokens after close.
		const s1 = await createPhoneUploadSession({ host: "127.0.0.1", enableTunnel: true });
		assert.equal(s1.tunnelStatus, "ready");
		assert.equal(s1.tunnelUrl, "https://warm-demo.trycloudflare.com");

		// Warm POST route returns 200 and does not tear down an active session.
		const warmRes = await postPhoneRoute(new Request("http://localhost/api/attachments/phone", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ warm: true }),
		}));
		assert.equal(warmRes.status, 200);
		assert.equal(pollPhoneUploadSession(s1.sessionId, 0).active, true);

		const livePageRes = await fetch(`http://127.0.0.1:${gatewayPort}/p/${encodeURIComponent(s1.token)}`);
		assert.equal(livePageRes.status, 200);

		await closePhoneUploadSession(s1.sessionId);
		const afterCloseRes = await fetch(`http://127.0.0.1:${gatewayPort}/p/${encodeURIComponent(s1.token)}`);
		assert.equal(afterCloseRes.status, 404);

		const s2 = await createPhoneUploadSession({ host: "127.0.0.1", enableTunnel: true });
		assert.equal(s2.tunnelStatus, "ready");
		assert.equal(s2.tunnelUrl, "https://warm-demo.trycloudflare.com");
		await closePhoneUploadSession(s2.sessionId);
	});
});

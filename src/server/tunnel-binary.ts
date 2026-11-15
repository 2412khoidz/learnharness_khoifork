import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

export interface CloudflaredAssetSpec {
	assetName: string;
	binaryName: string;
	archive: "none" | "tgz";
}

const RELEASE_BASE_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download";
const DOWNLOAD_TIMEOUT_MS = 45_000;
const inFlightDownloads = new Map<string, Promise<string | null>>();

/** Map OS + CPU architecture to the official Cloudflare release binary. */
export function resolveCloudflaredAsset(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): CloudflaredAssetSpec | null {
	if (platform === "win32") {
		if (arch === "x64" || arch === "arm64") {
			// arm64 Windows runs amd64 cleanly via x64 emulation and Cloudflare ships amd64/386 only.
			return { assetName: "cloudflared-windows-amd64.exe", binaryName: "cloudflared.exe", archive: "none" };
		}
		if (arch === "ia32") {
			return { assetName: "cloudflared-windows-386.exe", binaryName: "cloudflared.exe", archive: "none" };
		}
		return null;
	}
	if (platform === "linux") {
		if (arch === "x64") return { assetName: "cloudflared-linux-amd64", binaryName: "cloudflared", archive: "none" };
		if (arch === "arm64") return { assetName: "cloudflared-linux-arm64", binaryName: "cloudflared", archive: "none" };
		if (arch === "arm") return { assetName: "cloudflared-linux-arm", binaryName: "cloudflared", archive: "none" };
		if (arch === "ia32") return { assetName: "cloudflared-linux-386", binaryName: "cloudflared", archive: "none" };
		return null;
	}
	if (platform === "darwin") {
		if (arch === "arm64") return { assetName: "cloudflared-darwin-arm64.tgz", binaryName: "cloudflared", archive: "tgz" };
		if (arch === "x64") return { assetName: "cloudflared-darwin-amd64.tgz", binaryName: "cloudflared", archive: "tgz" };
		return null;
	}
	return null;
}

function isUsableBinary(filePath: string): boolean {
	try {
		const stat = fs.statSync(/* turbopackIgnore: true */ filePath);
		return stat.isFile() && stat.size > 0;
	} catch {
		return false;
	}
}

/** Find an existing cloudflared executable from env override, app cache, or system PATH. */
export function findInstalledCloudflared(
	binDir: string,
	env: Record<string, string | undefined> = process.env,
): string | null {
	const override = env.CLOUDFLARED_PATH?.trim();
	if (override && isUsableBinary(override)) return override;

	const binaryName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
	const cached = path.join(/* turbopackIgnore: true */ binDir, binaryName);
	if (isUsableBinary(cached)) return cached;

	const pathVar = env.PATH ?? env.Path ?? "";
	for (const entry of pathVar.split(path.delimiter)) {
		const trimmed = entry.trim().replace(/^"+|"+$/g, "");
		if (!trimmed) continue;
		const candidate = path.join(/* turbopackIgnore: true */ trimmed, binaryName);
		if (isUsableBinary(candidate)) return candidate;
	}
	return null;
}

function extractTgz(archivePath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("tar", ["-xzf", archivePath, "-C", destDir], {
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr?.on("data", (d) => {
			stderr = (stderr + String(d)).slice(-512);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `tar exited with code ${code ?? "unknown"}`));
		});
	});
}

async function downloadCloudflaredBinary(binDir: string, spec: CloudflaredAssetSpec): Promise<string | null> {
	const targetPath = path.join(/* turbopackIgnore: true */ binDir, spec.binaryName);
	const tempSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
	const downloadPath = path.join(/* turbopackIgnore: true */ binDir, `${spec.assetName}.tmp-${tempSuffix}`);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	timer.unref?.();

	try {
		fs.mkdirSync(/* turbopackIgnore: true */ binDir, { recursive: true });
		const response = await fetch(`${RELEASE_BASE_URL}/${spec.assetName}`, {
			redirect: "follow",
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length < 1_000_000) return null;

		fs.writeFileSync(/* turbopackIgnore: true */ downloadPath, bytes);
		if (spec.archive === "tgz") {
			await extractTgz(downloadPath, binDir);
		} else {
			fs.renameSync(/* turbopackIgnore: true */ downloadPath, /* turbopackIgnore: true */ targetPath);
		}
		if (process.platform !== "win32") {
			fs.chmodSync(/* turbopackIgnore: true */ targetPath, 0o755);
		}
		return isUsableBinary(targetPath) ? targetPath : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		try {
			fs.unlinkSync(/* turbopackIgnore: true */ downloadPath);
		} catch {
			// temp file may already be renamed
		}
	}
}

export interface EnsureCloudflaredOptions {
	binDir?: string;
}

/** Return a usable cloudflared binary path, lazily downloading it once into app data if missing. */
export async function ensureCloudflaredBinary(options: EnsureCloudflaredOptions = {}): Promise<string | null> {
	const binDir = options.binDir ?? path.join(/* turbopackIgnore: true */ PATHS.data, "bin");
	const existing = findInstalledCloudflared(binDir);
	if (existing) return existing;

	const spec = resolveCloudflaredAsset();
	if (!spec) return null;

	const pending = inFlightDownloads.get(binDir);
	if (pending) return pending;

	const task = downloadCloudflaredBinary(binDir, spec).finally(() => {
		inFlightDownloads.delete(binDir);
	});
	inFlightDownloads.set(binDir, task);
	return task;
}

export interface TunnelReadinessDeps {
	resolvePublic?: (hostname: string) => Promise<string[]>;
	lookupOs?: (hostname: string) => Promise<string>;
	fetchFn?: typeof fetch;
	pollIntervalMs?: number;
}

function isDnsNotFoundError(err: unknown): boolean {
	const code = (err as { code?: string } | null)?.code;
	return code === "ENOTFOUND" || code === "ENODATA";
}

function createPublicResolver(): (hostname: string) => Promise<string[]> {
	const resolver = new dns.Resolver({ timeout: 1_500, tries: 1 });
	resolver.setServers(["1.1.1.1", "8.8.8.8"]);
	return async (hostname: string) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		try {
			return await Promise.race([
				resolver.resolve4(hostname),
				new Promise<string[]>((_, reject) => {
					timer = setTimeout(
						() => reject(Object.assign(new Error("Public DNS timeout"), { code: "ETIMEOUT" })),
						2_000,
					);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
}

async function resolveTunnelHostname(
	hostname: string,
	isCancelled: () => boolean,
	startTime: number,
	deadline: number,
	headstartMs: number,
	pollMs: number,
	resolvePublic: (hostname: string) => Promise<string[]>,
	lookupOs: (hostname: string) => Promise<string>,
): Promise<boolean> {
	while (!isCancelled() && Date.now() < deadline) {
		let allowOsFallback = Date.now() - startTime >= headstartMs;
		try {
			const ips = await resolvePublic(hostname);
			if (ips.length > 0) return true;
		} catch (err) {
			// If direct UDP 53 to 1.1.1.1/8.8.8.8 is blocked or unreachable, fall back immediately to OS DNS.
			if (!isDnsNotFoundError(err)) {
				allowOsFallback = true;
			}
		}

		if (allowOsFallback && !isCancelled()) {
			try {
				const address = await lookupOs(hostname);
				if (address) return true;
			} catch {
				// keep polling until OS resolver catches up or deadline expires
			}
		}

		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
}

/**
 * Wait for a new Quick Tunnel hostname to resolve on Cloudflare/Google public DNS before calling OS fetch,
 * preventing Windows DNS Client from caching an early NXDOMAIN while the subdomain finishes propagating.
 * Falls back to OS DNS resolution if public DNS port 53 is blocked or slow to answer.
 */
export async function waitForTunnelReadiness(
	tunnelUrl: string,
	pingPath: string,
	isCancelled: () => boolean,
	timeoutMs = 24_000,
	deps?: TunnelReadinessDeps,
): Promise<boolean> {
	let hostname = "";
	try {
		hostname = new URL(tunnelUrl).hostname;
	} catch {
		return false;
	}

	const startTime = Date.now();
	const deadline = startTime + timeoutMs;
	const headstartMs = Math.min(6_000, Math.floor(timeoutMs * 0.35));
	const pollMs = deps?.pollIntervalMs ?? 400;
	const resolvePublic = deps?.resolvePublic ?? createPublicResolver();
	const lookupOs = deps?.lookupOs ?? (async (host: string) => (await dns.lookup(host)).address);
	const fetchFn = deps?.fetchFn ?? fetch;

	const dnsReady = await resolveTunnelHostname(
		hostname,
		isCancelled,
		startTime,
		deadline,
		headstartMs,
		pollMs,
		resolvePublic,
		lookupOs,
	);
	if (!dnsReady || isCancelled()) return false;

	const normalizedPing = pingPath.startsWith("/") ? pingPath : `/${pingPath}`;
	while (!isCancelled() && Date.now() < deadline) {
		const controller = new AbortController();
		const reqTimer = setTimeout(() => controller.abort(), 3_000);
		try {
			const res = await fetchFn(`${tunnelUrl.replace(/\/+$/, "")}${normalizedPing}`, {
				method: "GET",
				cache: "no-store",
				signal: controller.signal,
			});
			if (res.ok) return true;
		} catch {
			// OS DNS resolver may lag public DNS by ~1s; retry briefly
		} finally {
			clearTimeout(reqTimer);
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
}

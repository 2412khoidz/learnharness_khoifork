import { NextResponse } from "next/server";
import { closeWebShareSession, getWebShareStatus, startWebShareSession } from "@/src/server";

function isRemoteClient(request: Request): boolean {
	return request.headers.get("x-lh-web-share-remote") === "1";
}

function resolveTargetPort(request: Request): number {
	const envPort = Number.parseInt(process.env.PORT ?? "", 10);
	if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65_535) {
		return envPort;
	}
	try {
		const url = new URL(request.url);
		if (url.port) {
			const parsed = Number.parseInt(url.port, 10);
			if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) return parsed;
		}
		return url.protocol === "https:" ? 443 : 80;
	} catch {
		return 3000;
	}
}

export async function GET(request: Request) {
	if (isRemoteClient(request)) {
		return NextResponse.json(
			{
				active: false,
				remoteClient: true,
				tunnelStatus: "idle",
				tunnelUrl: null,
				tunnelError: null,
				shareUrl: null,
				lanShareUrl: null,
			},
			{ headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.json(getWebShareStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	if (isRemoteClient(request)) {
		return NextResponse.json(
			{ error: "Web Share controls are only available on the host computer." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	let body: { action?: unknown; tunnel?: unknown } = {};
	try {
		const text = await request.text();
		if (text.trim()) body = JSON.parse(text) as { action?: unknown; tunnel?: unknown };
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: { "Cache-Control": "no-store" } });
	}
	const info = await startWebShareSession({
		targetPort: resolveTargetPort(request),
		refresh: body.action === "refresh",
		tunnel: body.tunnel !== false,
	});
	return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
	if (isRemoteClient(request)) {
		return NextResponse.json(
			{ error: "Web Share controls are only available on the host computer." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	await closeWebShareSession();
	return NextResponse.json({ ok: true, ...getWebShareStatus() }, { headers: { "Cache-Control": "no-store" } });
}

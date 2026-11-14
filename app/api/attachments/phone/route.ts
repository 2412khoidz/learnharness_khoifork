import { NextResponse } from "next/server";
import {
	closePhoneUploadSession,
	createPhoneUploadSession,
	pollPhoneUploadSession,
	warmPhoneUploadTunnel,
} from "@/src/server";

export const runtime = "nodejs";

export async function POST(request?: Request): Promise<Response> {
	let warm = false;
	let refreshTunnel = false;
	if (request) {
		try {
			const body = (await request.json()) as { warm?: unknown; refreshTunnel?: unknown } | null;
			warm = body?.warm === true;
			refreshTunnel = body?.refreshTunnel === true;
		} catch {
			// Empty or non-JSON POST body starts a standard phone upload session.
		}
	}
	try {
		if (warm) {
			if (process.env.NODE_ENV !== "test") {
				void warmPhoneUploadTunnel();
			}
			return NextResponse.json({ ok: true });
		}
		const session = await createPhoneUploadSession({
			enableTunnel: process.env.NODE_ENV !== "test",
			refreshTunnel,
		});
		return NextResponse.json(session);
	} catch {
		return NextResponse.json({ error: "Failed to start phone upload listener" }, { status: 500 });
	}
}

export async function GET(request: Request): Promise<Response> {
	const { searchParams } = new URL(request.url);
	const sessionId = searchParams.get("sessionId") ?? "";
	const sinceRaw = searchParams.get("since");
	const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : 0;
	if (!sessionId) {
		return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
	}
	return NextResponse.json(pollPhoneUploadSession(sessionId, Number.isFinite(since) ? since : 0));
}

export async function DELETE(request: Request): Promise<Response> {
	const { searchParams } = new URL(request.url);
	const sessionId = searchParams.get("sessionId");
	const closed = await closePhoneUploadSession(sessionId);
	return NextResponse.json({ closed });
}

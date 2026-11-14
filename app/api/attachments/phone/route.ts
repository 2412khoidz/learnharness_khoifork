import { NextResponse } from "next/server";
import {
	closePhoneUploadSession,
	createPhoneUploadSession,
	pollPhoneUploadSession,
} from "@/src/server";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
	try {
		const session = await createPhoneUploadSession({
			enableTunnel: process.env.NODE_ENV !== "test",
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

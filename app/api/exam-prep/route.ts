import type { ExamPrepPatch } from "@/src/core";
import { readExamPrepStatus, syncExamPrepToPlanner, writeExamPrepConfig } from "@/src/server";

export async function GET() {
	return Response.json(readExamPrepStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "Expected JSON object" }, { status: 400 });
	}
	writeExamPrepConfig(body as ExamPrepPatch);
	syncExamPrepToPlanner();
	return Response.json(readExamPrepStatus(), { headers: { "Cache-Control": "no-store" } });
}

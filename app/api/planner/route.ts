import { patchPlannerConfig, readPlannerSnapshot, type PlannerPatch } from "@/src/server";

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const date = searchParams.get("date") ?? undefined;
	return Response.json(readPlannerSnapshot({ date }), { headers: { "Cache-Control": "no-store" } });
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
	return Response.json(patchPlannerConfig(body as PlannerPatch), { headers: { "Cache-Control": "no-store" } });
}

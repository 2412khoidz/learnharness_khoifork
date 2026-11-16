import type { HabitCheckInPatch } from "@/src/core";
import { checkInPlannerHabit } from "@/src/server";

export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "Expected JSON object" }, { status: 400 });
	}
	return Response.json(checkInPlannerHabit(body as HabitCheckInPatch), {
		headers: { "Cache-Control": "no-store" },
	});
}

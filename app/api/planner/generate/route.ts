import type { PlannerEngineMode } from "@/src/core";
import { generatePlannerSchedule, PlannerAiUnavailable } from "@/src/server";

export async function POST(request: Request) {
	let body: Record<string, unknown> = {};
	try {
		const raw = (await request.json()) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
	} catch {
		// Allow empty POST body to use active engineMode
	}

	const mode: PlannerEngineMode | undefined =
		body.mode === "llm" || body.mode === "local" ? body.mode : undefined;
	const date = typeof body.date === "string" ? body.date : undefined;
	const focusNote = typeof body.focusNote === "string" ? body.focusNote : undefined;

	try {
		const { snapshot } = await generatePlannerSchedule({
			mode,
			date,
			focusNote,
			signal: request.signal,
		});
		return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		if (err instanceof PlannerAiUnavailable) {
			return Response.json({ error: err.message }, { status: 503 });
		}
		const message = err instanceof Error ? err.message : "Failed to generate schedule";
		return Response.json({ error: message }, { status: 502 });
	}
}

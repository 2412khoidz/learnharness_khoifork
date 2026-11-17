import type { ModelRole } from "@/config";
import {
	calibratePlannerFromCapacityServer,
	diagnoseLearningCapacityWithAiServer,
	PlannerAiUnavailable,
	readPlannerLearningCapacityServer,
} from "@/src/server";

const ALLOWED_ROLES = new Set<string>(["researcher", "prober", "analyst", "sideQuestion", "visualMaker", "pdfReader"]);

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const date = searchParams.get("date") ?? undefined;
	const { recallSources: _recallSources, ...capacity } = readPlannerLearningCapacityServer({ date });
	void _recallSources;
	return Response.json(capacity, {
		headers: { "Cache-Control": "no-store" },
	});
}

export async function POST(request: Request) {
	let body: Record<string, unknown> = {};
	try {
		const raw = (await request.json()) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const action = typeof body.action === "string" ? body.action : "apply_realism";
	const date = typeof body.date === "string" ? body.date : undefined;
	const preferredRole =
		typeof body.preferredRole === "string" && ALLOWED_ROLES.has(body.preferredRole)
			? (body.preferredRole as ModelRole)
			: undefined;

	if (action === "diagnose_ai") {
		try {
			const res = await diagnoseLearningCapacityWithAiServer({
				date,
				preferredRole,
				signal: request.signal,
			});
			return Response.json(res, { headers: { "Cache-Control": "no-store" } });
		} catch (err) {
			if (err instanceof PlannerAiUnavailable) {
				return Response.json({ error: err.message }, { status: 503 });
			}
			return Response.json(
				{ error: err instanceof Error ? err.message : "Failed to run cognitive diagnosis" },
				{ status: 502 },
			);
		}
	}

	if (action === "apply_realism") {
		const res = calibratePlannerFromCapacityServer({ date });
		return Response.json(res, { headers: { "Cache-Control": "no-store" } });
	}

	return Response.json({ error: `Unsupported action: ${action}` }, { status: 400 });
}

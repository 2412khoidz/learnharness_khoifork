import type { ModelRole } from "@/config";
import { PlannerAiUnavailable, suggestLifestyleBalanceServer } from "@/src/server";

const ALLOWED_ROLES = new Set<string>(["researcher", "prober", "analyst", "sideQuestion", "visualMaker", "pdfReader"]);

export async function POST(request: Request) {
	let body: Record<string, unknown> = {};
	try {
		const raw = (await request.json()) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
	} catch {
		// empty body defaults to local mode
	}
	const useAi = Boolean(body.useAi);
	const preferredRole =
		typeof body.preferredRole === "string" && ALLOWED_ROLES.has(body.preferredRole)
			? (body.preferredRole as ModelRole)
			: undefined;

	try {
		const suggestion = await suggestLifestyleBalanceServer({
			useAi,
			preferredRole,
			signal: request.signal,
		});
		return Response.json(suggestion, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		if (err instanceof PlannerAiUnavailable) {
			return Response.json({ error: err.message }, { status: 503 });
		}
		return Response.json({ error: err instanceof Error ? err.message : "Failed to optimize lifestyle" }, { status: 502 });
	}
}

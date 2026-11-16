import type { ModelRole } from "@/config";
import {
	chatWithPlannerCoachServer,
	clearPlannerCoachChatServer,
	PlannerAiUnavailable,
	undoPlannerCoachChangeServer,
} from "@/src/server";

const ALLOWED_ROLES = new Set<string>(["researcher", "prober", "analyst", "sideQuestion", "visualMaker", "pdfReader"]);

export async function POST(request: Request) {
	let body: Record<string, unknown> = {};
	try {
		const raw = (await request.json()) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const action = typeof body.action === "string" ? body.action : "send";
	const date = typeof body.date === "string" ? body.date : undefined;

	if (action === "undo") {
		const messageId = typeof body.messageId === "string" ? body.messageId : undefined;
		const res = undoPlannerCoachChangeServer({ messageId, date });
		return Response.json(res, { headers: { "Cache-Control": "no-store" } });
	}

	if (action === "clear") {
		const snapshot = clearPlannerCoachChatServer({ date });
		return Response.json({ snapshot }, { headers: { "Cache-Control": "no-store" } });
	}

	const message = typeof body.message === "string" ? body.message : "";
	if (!message.trim()) {
		return Response.json({ error: "Message is required" }, { status: 400 });
	}

	const focusArea =
		body.focusArea === "schedule" || body.focusArea === "lifestyle" || body.focusArea === "general"
			? body.focusArea
			: "general";
	const preferredRole =
		typeof body.preferredRole === "string" && ALLOWED_ROLES.has(body.preferredRole)
			? (body.preferredRole as ModelRole)
			: undefined;

	try {
		const res = await chatWithPlannerCoachServer({
			message,
			focusArea,
			preferredRole,
			date,
			signal: request.signal,
		});
		return Response.json(res, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		if (err instanceof PlannerAiUnavailable) {
			return Response.json({ error: err.message }, { status: 503 });
		}
		return Response.json(
			{ error: err instanceof Error ? err.message : "Coach request failed" },
			{ status: 502 },
		);
	}
}

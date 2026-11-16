import type { ModelRole } from "@/config";
import {
	chatWithPlannerCoachServer,
	clearPlannerCoachChatServer,
	PlannerAiUnavailable,
	undoPlannerCoachChangeServer,
	prepareCoachAttachments,
} from "@/src/server";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";

const ALLOWED_ROLES = new Set<string>(["researcher", "prober", "analyst", "sideQuestion", "visualMaker", "pdfReader"]);

export async function POST(request: Request) {
	let body: Record<string, unknown> = {};
	let files: File[] = [];
	try {
		let raw: unknown;
		if (request.headers.get("content-type")?.includes("multipart/form-data")) {
			const form = await readBoundedFormData(request, 26 * 1024 * 1024, request.signal);
			const payload = form.get("payload");
			raw = JSON.parse(typeof payload === "string" ? payload : "{}");
			const entries = form.getAll("files");
			if (entries.some((file) => !(file instanceof File))) throw new Error("Invalid attachment.");
			files = entries as File[];
		} else raw = await request.json();
		if (raw && typeof raw === "object" && !Array.isArray(raw)) body = raw as Record<string, unknown>;
	} catch (error) {
		return Response.json({ error: error instanceof FormBodyLimitError ? "Attachments exceed the 25 MB total limit." : "Invalid request body." }, { status: error instanceof FormBodyLimitError ? 413 : 400 });
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
	if (!message.trim() && files.length === 0) {
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

	let prepared: Awaited<ReturnType<typeof prepareCoachAttachments>> | undefined;
	try {
		prepared = await prepareCoachAttachments(files);
		prepared.save();
		const res = await chatWithPlannerCoachServer({
			message,
			focusArea,
			preferredRole,
			date,
			attachments: prepared.attachments,
			attachmentText: prepared.attachmentText,
			images: prepared.images,
			signal: request.signal,
		});
		return Response.json(res, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		prepared?.cleanupIfUnreferenced();
		if (err instanceof PlannerAiUnavailable) {
			return Response.json({ error: err.message }, { status: 503 });
		}
		return Response.json(
			{ error: err instanceof Error ? err.message : "Coach request failed" },
			{ status: 502 },
		);
	}
}

import type { ModelRole } from "@/config";
import type { MilestoneKind } from "@/src/core";
import { PlannerAiUnavailable, researchExamSyllabus, type ResearchTraceStep } from "@/src/server";

const ALLOWED_ROLES = new Set<string>(["researcher", "prober", "analyst", "sideQuestion", "visualMaker", "pdfReader"]);

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
	const obj = body as Record<string, unknown>;
	const title = typeof obj.title === "string" ? obj.title.trim() : "";
	const clusterIds = Array.isArray(obj.clusterIds)
		? obj.clusterIds.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
		: undefined;
	const examProfileId = typeof obj.examProfileId === "string" && obj.examProfileId.trim() ? obj.examProfileId.trim() : undefined;
	const pullOnly = Boolean(obj.pullOnly);

	if (!title && !pullOnly && (!clusterIds || clusterIds.length === 0) && !examProfileId) {
		return Response.json({ error: "Exam or competition title is required." }, { status: 400 });
	}
	const kindRaw = obj.kind;
	const kind: MilestoneKind | undefined =
		kindRaw === "exam" || kindRaw === "competition" || kindRaw === "project" || kindRaw === "deadline"
			? kindRaw
			: undefined;
	const dueDate = typeof obj.dueDate === "string" ? obj.dueDate : undefined;
	const materialsText = typeof obj.materialsText === "string" ? obj.materialsText : undefined;
	const preferLocal = Boolean(obj.preferLocal);
	const preferredRole =
		typeof obj.preferredRole === "string" && ALLOWED_ROLES.has(obj.preferredRole)
			? (obj.preferredRole as ModelRole)
			: undefined;
	const stream = Boolean(obj.stream);

	if (!stream) {
		try {
			const researched = await researchExamSyllabus({
				title,
				kind,
				dueDate,
				materialsText,
				clusterIds,
				examProfileId,
				pullOnly,
				preferLocal,
				preferredRole,
				signal: request.signal,
			});
			return Response.json(researched, { headers: { "Cache-Control": "no-store" } });
		} catch (err) {
			if (err instanceof PlannerAiUnavailable) {
				return Response.json({ error: err.message }, { status: 503 });
			}
			return Response.json({ error: err instanceof Error ? err.message : "Failed to research syllabus" }, { status: 502 });
		}
	}

	const encoder = new TextEncoder();
	const bodyStream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const sendLine = (payload: unknown) => {
				try {
					controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
				} catch {
					// Stream already closed
				}
			};
			try {
				const researched = await researchExamSyllabus({
					title,
					kind,
					dueDate,
					materialsText,
					clusterIds,
					examProfileId,
					pullOnly,
					preferLocal,
					preferredRole,
					signal: request.signal,
					onStep: (step: ResearchTraceStep) => sendLine({ type: "step", step }),
				});
				sendLine({ type: "result", data: researched });
			} catch (err) {
				const status = err instanceof PlannerAiUnavailable ? 503 : 502;
				sendLine({
					type: "error",
					status,
					error: err instanceof Error ? err.message : "Failed to research syllabus",
				});
			} finally {
				try {
					controller.close();
				} catch {
					// Already closed
				}
			}
		},
	});

	return new Response(bodyStream, {
		headers: {
			"Content-Type": "application/x-ndjson; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

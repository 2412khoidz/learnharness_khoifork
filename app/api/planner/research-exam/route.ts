import type { MilestoneKind } from "@/src/core";
import { PlannerAiUnavailable, researchExamSyllabus } from "@/src/server";

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

	if (!title && !pullOnly && !examProfileId && (!clusterIds || clusterIds.length === 0)) {
		return Response.json({ error: "Exam or competition title is required." }, { status: 400 });
	}
	const kindRaw = obj.kind;
	const kind: MilestoneKind | undefined =
		kindRaw === "exam" || kindRaw === "competition" || kindRaw === "project" || kindRaw === "deadline"
			? kindRaw
			: undefined;

	try {
		const researched = await researchExamSyllabus({
			title,
			kind,
			dueDate: typeof obj.dueDate === "string" ? obj.dueDate : undefined,
			materialsText: typeof obj.materialsText === "string" ? obj.materialsText : undefined,
			clusterIds,
			examProfileId,
			pullOnly,
			preferLocal: Boolean(obj.preferLocal),
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

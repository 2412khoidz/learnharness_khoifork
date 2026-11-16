import type { ModelRole } from "@/config";
import type { MilestoneKind, SyllabusTopic } from "@/src/core";
import { estimateMilestoneWorkloadServer, PlannerAiUnavailable } from "@/src/server";

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
	const subject = typeof obj.subject === "string" ? obj.subject.trim() : title;
	if (!title && !subject) {
		return Response.json({ error: "Milestone title or subject is required." }, { status: 400 });
	}
	const kindRaw = obj.kind;
	const kind: MilestoneKind | undefined =
		kindRaw === "exam" || kindRaw === "competition" || kindRaw === "project" || kindRaw === "deadline"
			? kindRaw
			: undefined;
	const dueDate = typeof obj.dueDate === "string" ? obj.dueDate : undefined;
	const baseHours = typeof obj.baseHours === "number" && Number.isFinite(obj.baseHours) ? obj.baseHours : undefined;
	const syllabusTopics = Array.isArray(obj.syllabusTopics) ? (obj.syllabusTopics as SyllabusTopic[]) : undefined;
	const clusterIds = Array.isArray(obj.clusterIds)
		? obj.clusterIds.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
		: undefined;
	const useAi = Boolean(obj.useAi);
	const preferredRole =
		typeof obj.preferredRole === "string" && ALLOWED_ROLES.has(obj.preferredRole)
			? (obj.preferredRole as ModelRole)
			: undefined;

	try {
		const estimate = await estimateMilestoneWorkloadServer({
			title: title || subject,
			subject,
			kind,
			dueDate,
			baseHours,
			syllabusTopics,
			clusterIds,
			useAi,
			preferredRole,
			signal: request.signal,
		});
		return Response.json(estimate, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		if (err instanceof PlannerAiUnavailable) {
			return Response.json({ error: err.message }, { status: 503 });
		}
		return Response.json({ error: err instanceof Error ? err.message : "Failed to estimate workload" }, { status: 502 });
	}
}

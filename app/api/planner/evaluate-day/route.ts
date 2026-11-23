import type { ModelRole } from "@/config";
import type { JournalActivityEntry } from "@/src/core";
import { evaluateDailyJournalServer, PlannerAiUnavailable } from "@/src/server";

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
	const date = typeof obj.date === "string" ? obj.date.trim() : undefined;
	const journalText = typeof obj.journalText === "string" ? obj.journalText : undefined;
	const manualEntries = Array.isArray(obj.manualEntries) ? (obj.manualEntries as JournalActivityEntry[]) : undefined;
	const mode = obj.mode === "llm" ? "llm" : "local";
	const discreet = obj.discreet !== false;
	const formatJournal = obj.formatJournal !== false;
	const preferredRole =
		typeof obj.preferredRole === "string" && ALLOWED_ROLES.has(obj.preferredRole)
			? (obj.preferredRole as ModelRole)
			: undefined;

	try {
		const res = await evaluateDailyJournalServer({
			date,
			journalText,
			manualEntries,
			mode,
			discreet,
			formatJournal,
			preferredRole,
			signal: request.signal,
		});
		return Response.json(res, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		if (err instanceof PlannerAiUnavailable) {
			return Response.json({ error: err.message }, { status: 503 });
		}
		return Response.json({ error: err instanceof Error ? err.message : "Failed to evaluate daily journal" }, { status: 502 });
	}
}

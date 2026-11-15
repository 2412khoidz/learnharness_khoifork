import { enqueueAnalyses, readMistakes, recordExplainMistake } from "@/src/server";

export const dynamic = "force-dynamic";

/** One session's recorded mistakes — the answer cards read the short "why"
 *  from here (keyed by the answer's tool call: `<chatId>:<toolCallId>`). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return Response.json({ mistakes: readMistakes().filter((r) => r.chatId === id) });
}

/** Manually save one answered free-recall (`explain` / `recall`) card into
 *  the Mistake Log and immediately queue its short error analysis. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => null)) as { toolCallId?: unknown } | null;
	const toolCallId = typeof body?.toolCallId === "string" ? body.toolCallId.trim() : "";
	if (!toolCallId) return Response.json({ error: "toolCallId is required" }, { status: 400 });
	const saved = recordExplainMistake(id, toolCallId);
	if (!saved) {
		return Response.json({ error: "Answered free-recall check not found for this session" }, { status: 404 });
	}
	if (saved.mistake.status !== "ready") enqueueAnalyses([saved.mistake.id]);
	const mistake = readMistakes().find((r) => r.id === saved.mistake.id) ?? saved.mistake;
	return Response.json({ mistake, created: saved.created });
}

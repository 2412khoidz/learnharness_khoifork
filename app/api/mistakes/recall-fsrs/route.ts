import { confirmRecallFsrs, recallFsrsReviewData, undoRecallFsrsBatch, suggestRecallMappings } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try { return Response.json(recallFsrsReviewData(), { headers: { "Cache-Control": "no-store" } }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not load recall reviews." }, { status: 500 }); }
}

export async function POST(request: Request) {
	try {
		const body: unknown = await request.json();
		if (body && typeof body === "object" && (body as { action?: unknown }).action === "suggest") {
			const input = body as { ids?: unknown; discussion?: unknown };
			if (!Array.isArray(input.ids) || input.ids.some((id) => typeof id !== "string")) throw new Error("Invalid answer selection.");
			let discussion: { question: string; history: Array<{ role: string; text: string }> } | undefined;
			if (input.discussion !== undefined) {
				const d = input.discussion as { question?: unknown; history?: unknown };
				if (!d || typeof d.question !== "string" || !Array.isArray(d.history) || d.history.some((entry: unknown) => !entry || typeof entry !== "object" || !["user", "assistant"].includes((entry as { role: string }).role) || typeof (entry as { text: unknown }).text !== "string" || (entry as { text: string }).text.length > 2500)) throw new Error("Invalid discussion.");
				discussion = { question: d.question, history: d.history as Array<{ role: string; text: string }> };
			}
			return Response.json(await suggestRecallMappings(input.ids as string[], request.signal, discussion));
		}
		if (body && typeof body === "object" && (body as { action?: unknown }).action === "undo" && typeof (body as { batchId?: unknown }).batchId === "string") return Response.json({ undone: undoRecallFsrsBatch((body as { batchId: string }).batchId) });
		if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) return Response.json({ error: "Invalid request." }, { status: 400 });
		const items = (body as { items: Array<{ answerId: string; nodeId: string; rating: number; answerRevision: string; nodeRevision: string }> }).items;
		if (items.some((item) => !item || typeof item.answerId !== "string" || typeof item.nodeId !== "string" || typeof item.rating !== "number" || typeof item.answerRevision !== "string" || typeof item.nodeRevision !== "string")) return Response.json({ error: "Invalid review selection." }, { status: 400 });
		return Response.json({ added: confirmRecallFsrs(items) });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not save recall reviews." }, { status: 400 }); }
}

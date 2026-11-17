import type { ModelRole } from "@/config";
import { approveRecallGroups, recallGroupPreview, suggestRecallGroups, saveRecallGroupsDraft, recallFsrsReviewData, readMistakes } from "@/src/server";
import type { RecallGroup } from "@/src/core";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
	try { const params = new URL(request.url).searchParams; const answerId = params.get("answerId"); if (answerId) { const answer = recallFsrsReviewData().results.find((item) => item.id === answerId); if (!answer) throw new Error("This answer is unavailable or its assessment needs review."); const mistake = readMistakes().find((item) => item.id === answerId); return Response.json({ answer, mistake: mistake ? { status: mistake.status } : null }, { headers: { "Cache-Control": "no-store" } }); } const subject = params.get("subject") ?? ""; return Response.json(recallGroupPreview(subject, Number(params.get("offset") ?? 0)), { headers: { "Cache-Control": "no-store" } }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not load preview." }, { status: 400 }); }
}
export async function POST(request: Request) {
	try {
		const body = await request.json() as { action?: string; subject?: string; expected?: Array<{ id: string; fingerprint: string }>; preferredRole?: ModelRole; groups?: RecallGroup[]; offset?: number; approvedRevision?: string };
		if (typeof body.subject !== "string") throw new Error("Choose a subject.");
		if (body.action === "suggest") return Response.json(await suggestRecallGroups(body.subject, body.expected ?? [], body.preferredRole, request.signal, body.offset ?? 0));
		if (body.action === "approve") return Response.json(approveRecallGroups(body.subject, body.groups ?? [], body.approvedRevision ?? ""));
		if (body.action === "save_draft") return Response.json(saveRecallGroupsDraft(body.subject, body.groups ?? []));
		throw new Error("Unknown action.");
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not update recall groups." }, { status: 400 }); }
}

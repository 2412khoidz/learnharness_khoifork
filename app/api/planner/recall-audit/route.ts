import type { ModelRole } from "@/config";
import { recallAuditPreview, recallAudits, startRecallAudit, resumeRecallAudit, pauseRecallAudit, applyRecallAudit, undoRecallAudit } from "@/src/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
 try { return Response.json(new URL(request.url).searchParams.get("preview") === "1" ? recallAuditPreview() : { runs: recallAudits() }, { headers: { "Cache-Control": "no-store" } }); }
 catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not load audit." }, { status: 400 }); }
}
export async function POST(request: Request) {
 try {
  const input = await request.json() as { action?: string; id?: string; role?: ModelRole; expected?: Array<{ id: string; fingerprint: string }>; choices?: Array<{ id: string; removeMistake?: boolean }>; reviewId?: string };
  if (input.action === "start") return Response.json(startRecallAudit({ role: input.role, expected: input.expected ?? [] }));
  if (input.action === "resume" && input.id) return Response.json(resumeRecallAudit(input.id, input.role));
  if (input.action === "pause" && input.id) return Response.json(pauseRecallAudit(input.id));
  if (input.action === "apply" && input.id) return Response.json(applyRecallAudit(input.id, input.choices ?? []));
  if (input.action === "undo" && input.id && input.reviewId) return Response.json(undoRecallAudit(input.id, input.reviewId));
  throw new Error("Invalid audit action.");
 } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Audit action failed." }, { status: 400 }); }
}

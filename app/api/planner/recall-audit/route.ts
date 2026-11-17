import type { ModelRole } from "@/config";
import { recallAuditPreview, recallAudits, startRecallAudit, resumeRecallAudit, pauseRecallAudit, applyRecallAudit, undoRecallAudit, listAvailablePlannerRoles } from "@/src/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
 try {
  const params = new URL(request.url).searchParams;
  if (params.get("preview") === "1") return Response.json(recallAuditPreview(), { headers: { "Cache-Control": "no-store" } });
  const runs = recallAudits();
  if (params.get("summary") !== "1") return Response.json({ runs }, { headers: { "Cache-Control": "no-store" } });
  const selectedId = params.get("runId") || runs.at(-1)?.id;
  const page = Math.max(0, Math.min(100000, Number.parseInt(params.get("page") ?? "0", 10) || 0));
  return Response.json({ roles: listAvailablePlannerRoles(), runs: runs.map(({ items, results, ...run }) => ({ ...run, total: items.length, resultCount: results.length, results: run.id === selectedId ? results.slice(page * 20, (page + 1) * 20) : [] })) }, { headers: { "Cache-Control": "no-store" } });
 }
 catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not load audit." }, { status: 400 }); }
}
export async function POST(request: Request) {
 try {
  const input = await request.json() as { action?: string; id?: string; role?: ModelRole; expected?: Array<{ id: string; fingerprint: string }>; choices?: Array<{ id: string; removeMistake?: boolean }>; reviewId?: string; retrySkipped?: boolean };
  if (input.action === "start") return Response.json(startRecallAudit({ role: input.role, expected: input.expected ?? [] }));
  if (input.action === "resume" && input.id) return Response.json(resumeRecallAudit(input.id, input.role, input.retrySkipped === true));
  if (input.action === "pause" && input.id) return Response.json(pauseRecallAudit(input.id));
  if (input.action === "apply" && input.id) return Response.json(applyRecallAudit(input.id, input.choices ?? []));
  if (input.action === "undo" && input.id && input.reviewId) return Response.json(undoRecallAudit(input.id, input.reviewId));
  throw new Error("Invalid audit action.");
 } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Audit action failed." }, { status: 400 }); }
}

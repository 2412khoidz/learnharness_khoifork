import { readReviewProgress, saveReviewProgress } from "@/src/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
 try { return Response.json({ progress: readReviewProgress(new URL(request.url).searchParams.get("key") ?? "") }, { headers: { "Cache-Control": "no-store" } }); }
 catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not read progress." }, { status: 400 }); }
}
export async function POST(request: Request) {
 try { const body = await request.json() as { key: string; sequence: number; value: unknown }; saveReviewProgress(body.key, body.sequence, body.value); return Response.json({ saved: true }); }
 catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not save progress." }, { status: 400 }); }
}

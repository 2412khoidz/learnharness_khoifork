import { recallOverrideInfo, saveRecallOverride } from "@/src/server";
import type { RecallOverride } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
	try { return Response.json(recallOverrideInfo(new URL(request.url).searchParams.get("id") ?? ""), { headers: { "Cache-Control": "no-store" } }); }
	catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Answer unavailable." }, { status: 404 }); }
}
export async function POST(request: Request) {
	try {
		const body: unknown = await request.json();
		if (!body || typeof body !== "object" || typeof (body as { id?: unknown }).id !== "string" || typeof (body as { fingerprint?: unknown }).fingerprint !== "string") throw new Error("Invalid review.");
		return Response.json({ entry: saveRecallOverride(body as RecallOverride) });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Could not save review." }, { status: 400 }); }
}

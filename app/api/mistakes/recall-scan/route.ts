import { pauseRecallScan, recallScanStatus, saveRecallScanResults, startRecallScan } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(recallScanStatus());
}

export async function POST(req: Request) {
	const body = await req.json().catch(() => null) as { action?: string; ids?: unknown } | null;
	if (body?.action === "start") return Response.json(startRecallScan());
	if (body?.action === "pause") return Response.json(pauseRecallScan());
	if (body?.action === "save" && Array.isArray(body.ids) && body.ids.every((id) => typeof id === "string")) {
		return Response.json({ added: saveRecallScanResults(body.ids) });
	}
	return Response.json({ error: "Invalid recall scan request." }, { status: 400 });
}

import type { ImageContent } from "@earendil-works/pi-ai";
import { parseWeeklyScheduleInput, PlannerAiUnavailable } from "@/src/server";

function extractImageContent(rawDataUrl: unknown, mimeFallback: unknown): ImageContent[] {
	if (typeof rawDataUrl !== "string" || !rawDataUrl.trim()) return [];
	const trimmed = rawDataUrl.trim();
	const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(trimmed);
	if (dataUrlMatch) {
		const mimeType = dataUrlMatch[1]!;
		const data = dataUrlMatch[2]!;
		if (data.length > 10_000_000) throw new Error("Image exceeds size limit.");
		return [{ type: "image", data, mimeType }];
	}
	const mimeType = typeof mimeFallback === "string" && mimeFallback.startsWith("image/") ? mimeFallback : "image/png";
	if (trimmed.length > 10_000_000) throw new Error("Image exceeds size limit.");
	return [{ type: "image", data: trimmed, mimeType }];
}

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
	const rawText = typeof obj.rawText === "string" ? obj.rawText : undefined;
	const preferLocal = Boolean(obj.preferLocal);

	let images: ImageContent[] = [];
	try {
		images = extractImageContent(obj.imageDataUrl ?? obj.imageBase64, obj.mimeType);
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Invalid image" }, { status: 400 });
	}

	if (!rawText?.trim() && images.length === 0) {
		return Response.json({ error: "Provide schedule text or upload a timetable image." }, { status: 400 });
	}

	try {
		const result = await parseWeeklyScheduleInput({
			rawText,
			images,
			preferLocal,
			signal: request.signal,
		});
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch (err) {
		if (err instanceof PlannerAiUnavailable) {
			return Response.json({ error: err.message }, { status: 503 });
		}
		return Response.json({ error: err instanceof Error ? err.message : "Failed to parse schedule" }, { status: 502 });
	}
}

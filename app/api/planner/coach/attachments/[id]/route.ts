import { readCoachAttachment, readPlannerConfig } from "@/src/server";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const attachment = (readPlannerConfig().coachChat ?? []).flatMap((message) => message.attachments ?? []).find((item) => item.id === id);
	if (!attachment) return new Response("Not found", { status: 404 });
	const bytes = readCoachAttachment(id);
	if (!bytes) return new Response("Not found", { status: 404 });
	return new Response(new Uint8Array(bytes), { headers: {
		"Content-Type": "application/octet-stream",
		"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	} });
}

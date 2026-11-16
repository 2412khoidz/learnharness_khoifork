import { liveRecallGrades } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	const { id } = await context.params;
	return Response.json({ grades: liveRecallGrades(id) });
}

import { BackupError, exportLearningBackup, importLearningBackup } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	const bundle = exportLearningBackup();
	const dateStamp = new Date().toISOString().slice(0, 10);
	return new Response(JSON.stringify(bundle, null, 2), {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="kronoharness-backup-${dateStamp}.json"`,
			"Cache-Control": "no-store",
		},
	});
}

export async function POST(request: Request): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON backup file" }, { status: 400 });
	}

	try {
		const result = importLearningBackup(body);
		return Response.json(result, { status: 200 });
	} catch (err) {
		if (err instanceof BackupError) {
			return Response.json({ error: err.message }, { status: err.status });
		}
		return Response.json(
			{ error: err instanceof Error ? err.message : "Failed to restore backup" },
			{ status: 500 },
		);
	}
}

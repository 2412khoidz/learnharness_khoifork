import { extractPlannerMaterialFile } from "@/src/server";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";

const MAX_MATERIAL_UPLOAD_BYTES = 26 * 1024 * 1024;

export async function POST(request: Request) {
	let form: FormData;
	try {
		form = await readBoundedFormData(request, MAX_MATERIAL_UPLOAD_BYTES);
	} catch (err) {
		const oversized = err instanceof FormBodyLimitError;
		return Response.json(
			{ error: oversized ? "Material file exceeds 25 MB limit." : "Could not read uploaded file." },
			{ status: oversized ? 413 : 400 },
		);
	}

	const file = form.get("file");
	if (!(file instanceof File)) {
		return Response.json({ error: "Expected a file upload." }, { status: 400 });
	}

	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const extracted = await extractPlannerMaterialFile(file.name, bytes);
		return Response.json(
			{ ok: true, filename: file.name, ...extracted },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Failed to extract material." },
			{ status: 422 },
		);
	}
}

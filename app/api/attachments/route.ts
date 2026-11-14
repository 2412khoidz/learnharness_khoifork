import { NextResponse } from "next/server";
import { AttachmentError, MAX_ATTACHMENT_IMAGE_BYTES, saveAttachmentImage } from "@/src/server";

export const runtime = "nodejs";

async function readBoundedBytes(request: Request): Promise<Buffer> {
	const declared = request.headers.get("content-length");
	if (declared) {
		const parsed = Number.parseInt(declared, 10);
		if (Number.isFinite(parsed) && parsed > MAX_ATTACHMENT_IMAGE_BYTES + 65536) {
			throw new AttachmentError("Image exceeds the 25 MB limit", 413);
		}
	}

	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (contentType.includes("multipart/form-data")) {
		const form = await request.formData();
		const entry = form.get("file");
		if (!entry || typeof entry === "string") {
			throw new AttachmentError("Missing image file", 400);
		}
		if (entry.size > MAX_ATTACHMENT_IMAGE_BYTES) {
			throw new AttachmentError("Image exceeds the 25 MB limit", 413);
		}
		return Buffer.from(await entry.arrayBuffer());
	}

	if (request.body) {
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_ATTACHMENT_IMAGE_BYTES) {
				void reader.cancel().catch(() => {});
				throw new AttachmentError("Image exceeds the 25 MB limit", 413);
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
	}

	const buf = Buffer.from(await request.arrayBuffer());
	if (buf.length > MAX_ATTACHMENT_IMAGE_BYTES) {
		throw new AttachmentError("Image exceeds the 25 MB limit", 413);
	}
	return buf;
}

export async function POST(request: Request): Promise<Response> {
	try {
		const bytes = await readBoundedBytes(request);
		const saved = saveAttachmentImage(bytes, { prefix: "paste" });
		return NextResponse.json(saved);
	} catch (error) {
		if (error instanceof AttachmentError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		return NextResponse.json({ error: "Failed to save pasted image" }, { status: 500 });
	}
}

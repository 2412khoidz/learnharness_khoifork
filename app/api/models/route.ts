import {
	addCustomProviderModel,
	modelCatalog,
	refreshConnectionCatalog,
	removeCustomProviderModel,
	setProviderPaused,
} from "@/src/server";

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's SUPPORTED thinking levels (per its thinkingLevelMap). Static
 * catalog: no network, stable within a pi-ai version.
 */
export async function GET() {
	await refreshConnectionCatalog();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const action = typeof body.action === "string" ? body.action : "";
	const provider = typeof body.provider === "string" ? body.provider.trim() : "";
	if (!provider) {
		return Response.json({ error: "provider is required" }, { status: 400 });
	}

	if (action === "add-custom-model") {
		const id = typeof body.id === "string" ? body.id.trim() : "";
		if (!id) {
			return Response.json({ error: "model id is required" }, { status: 400 });
		}
		const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : id;
		const reasoning = typeof body.reasoning === "boolean" ? body.reasoning : true;
		const contextWindow = typeof body.contextWindow === "number" && body.contextWindow > 0 ? body.contextWindow : 200_000;
		addCustomProviderModel(provider, {
			id,
			name,
			reasoning,
			input: ["text", "image"],
			contextWindow,
		});
		await refreshConnectionCatalog(provider);
		return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
	}

	if (action === "remove-custom-model") {
		const id = typeof body.id === "string" ? body.id.trim() : "";
		if (!id) {
			return Response.json({ error: "model id is required" }, { status: 400 });
		}
		removeCustomProviderModel(provider, id);
		return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
	}

	if (action === "toggle-pause-provider") {
		if (typeof body.paused !== "boolean") {
			return Response.json({ error: "paused boolean is required" }, { status: 400 });
		}
		setProviderPaused(provider, body.paused);
		return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
	}

	return Response.json({ error: `Unsupported action: ${action}` }, { status: 400 });
}

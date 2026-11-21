import {
	addCustomProviderModel,
	modelCatalog,
	refreshConnectionCatalog,
	refreshModelCatalog,
	removeCustomProviderModel,
	setProviderPaused,
} from "@/src/server";
import type { ModelCatalogRefreshResponse } from "@/src/core";

const headers = { "Cache-Control": "no-store" };

/**
 * The model picker's data (model-control wave): pi-ai's configured-provider
 * catalog as client-safe DTOs — id/name/cost/context/modality plus each
 * model's supported thinking levels. Reads bundled and locally saved
 * metadata; the existing connection catalogs still refresh independently.
 */
export async function GET() {
	await refreshConnectionCatalog();
	return Response.json(modelCatalog(), { headers });
}

export async function POST(request: Request) {
	const raw = await request.text();
	if (!raw.trim()) {
		// Only this explicit refresh action may contact pi.dev. The API Proxy guards it.
		let outcome;
		try { outcome = await refreshModelCatalog(); }
		catch { return Response.json({ error: "Model catalog refresh failed" }, { status: 502, headers }); }
		return Response.json({ outcome, catalog: modelCatalog() } satisfies ModelCatalogRefreshResponse, { headers });
	}
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const action = typeof body.action === "string" ? body.action : "";
	if (action === "refresh-catalog") {
		let outcome;
		try { outcome = await refreshModelCatalog(); }
		catch { return Response.json({ error: "Model catalog refresh failed" }, { status: 502, headers }); }
		return Response.json({ outcome, catalog: modelCatalog() } satisfies ModelCatalogRefreshResponse, { headers });
	}
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

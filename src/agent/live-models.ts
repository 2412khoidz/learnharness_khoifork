import type { Api, Model, Provider } from "@earendil-works/pi-ai";

const GOOGLE_INPUT_LIMITS = {
	maxRequestBytes: 20_971_520,
	images: {
		maxPerRequest: 3600,
		resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
	},
};

const VERTEX_INPUT_LIMITS = {
	images: {
		resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
	},
};

const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

const GOOGLE_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

/**
 * Curated newly-released models that may not yet exist in the bundled
 * `@earendil-works/pi-ai` static JSON catalogs. Merged with provider catalogs
 * (without overriding entries already shipped by pi-ai).
 */
export const SUPPLEMENTAL_MODELS: Readonly<Record<string, readonly Model<Api>[]>> = {
	google: [
		{
			id: "gemini-4-hydrogen",
			name: "Gemini 4 Hydrogen",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...GOOGLE_THINKING_LEVEL_MAP },
			inputLimits: GOOGLE_INPUT_LIMITS,
		},
	],
	"google-vertex": [
		{
			id: "gemini-4-hydrogen",
			name: "Gemini 4 Hydrogen",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://{location}-aiplatform.googleapis.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...GOOGLE_THINKING_LEVEL_MAP },
			inputLimits: VERTEX_INPUT_LIMITS,
		},
	],
	"github-copilot": [
		{
			id: "gemini-4-hydrogen",
			name: "Gemini 4 Hydrogen",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			headers: { ...COPILOT_HEADERS },
			compat: {
				supportsStrictMode: true,
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
			inputLimits: VERTEX_INPUT_LIMITS,
		},
	],
};

const DYNAMIC_KEY = Symbol.for("lh.live.models.registry");
interface DynamicState {
	modelsByProvider: Map<string, Map<string, Model<Api>>>;
	lastProbeAt: Map<string, number>;
}

function registry(): DynamicState {
	const g = globalThis as typeof globalThis & { [DYNAMIC_KEY]?: DynamicState };
	if (!g[DYNAMIC_KEY]) {
		g[DYNAMIC_KEY] = { modelsByProvider: new Map(), lastProbeAt: new Map() };
	}
	return g[DYNAMIC_KEY];
}

const PROBE_TTL_MS = 5 * 60 * 1000;

/** Register dynamically discovered models for a provider at runtime. */
export function registerDynamicProviderModels(providerId: string, models: readonly Model<Api>[]): boolean {
	const state = registry();
	let bucket = state.modelsByProvider.get(providerId);
	if (!bucket) {
		bucket = new Map();
		state.modelsByProvider.set(providerId, bucket);
	}
	let changed = false;
	for (const model of models) {
		const normalized: Model<Api> = model.provider === providerId ? model : { ...model, provider: providerId };
		const prev = bucket.get(normalized.id);
		if (!prev || JSON.stringify(prev) !== JSON.stringify(normalized)) {
			bucket.set(normalized.id, normalized);
			changed = true;
		}
	}
	return changed;
}

export function getDynamicProviderModels(providerId: string): Model<Api>[] {
	const bucket = registry().modelsByProvider.get(providerId);
	return bucket ? [...bucket.values()] : [];
}

/** Merge static provider models with supplemental and live-discovered entries (static wins on id conflict). */
export function augmentProviderModels<TApi extends Api = Api>(
	providerId: string,
	baseModels: readonly Model<TApi>[],
): Model<Api>[] {
	const merged = new Map<string, Model<Api>>();
	for (const model of baseModels) {
		merged.set(model.id, model as Model<Api>);
	}
	for (const extra of SUPPLEMENTAL_MODELS[providerId] ?? []) {
		if (!merged.has(extra.id)) merged.set(extra.id, extra);
	}
	for (const live of getDynamicProviderModels(providerId)) {
		if (!merged.has(live.id)) merged.set(live.id, live);
	}
	return [...merged.values()];
}

/** Wrap a pi-ai Provider so its `getModels()` includes supplemental and live-discovered models. */
export function wrapProviderWithLiveModels<TApi extends Api>(provider: Provider<TApi>): Provider<Api> {
	const base = provider as Provider<Api>;
	return {
		...base,
		getModels: () => augmentProviderModels(base.id, base.getModels()),
		...(base.getAllModels
			? {
				getAllModels: () => {
					const all = base.getAllModels!();
					const existingChatIds = new Set(all.filter((m) => m.type === undefined || m.type === "chat").map((m) => m.id));
					const extras = augmentProviderModels(base.id, []).filter((m) => !existingChatIds.has(m.id));
					return [...all, ...extras];
				},
			}
			: {}),
	};
}

function formatModelDisplayName(id: string): string {
	return id
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => (/^\d+(?:\.\d+)?$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

function isGoogleChatCandidate(id: string, methods?: unknown): boolean {
	if (!id.startsWith("gemini-") && !id.startsWith("gemma-")) return false;
	if (/(embedding|imagen|veo|aqa|tts|audio|live|native-audio|vision|bisect|customtools-exp)/i.test(id)) return false;
	if (Array.isArray(methods) && !methods.includes("generateContent")) return false;
	return true;
}

/**
 * Probe provider `/models` endpoints (currently Google Gemini API & OpenRouter)
 * with a short timeout and 5-minute TTL cache so newly released provider models
 * become selectable without requiring an app update.
 */
export async function probeLiveProviderModels(
	providerId: string,
	apiKey: string | undefined,
	options: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<Model<Api>[]> {
	if (!options.force && (process.env.NODE_ENV === "test" || process.env.LH_LIVE_MODELS === "0")) {
		return getDynamicProviderModels(providerId);
	}
	if (!apiKey && providerId !== "openrouter") return [];

	const state = registry();
	const now = Date.now();
	const last = state.lastProbeAt.get(providerId) ?? 0;
	if (!options.force && now - last < PROBE_TTL_MS) {
		return getDynamicProviderModels(providerId);
	}
	state.lastProbeAt.set(providerId, now);

	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchFn !== "function") return getDynamicProviderModels(providerId);

	try {
		if (providerId === "google" && apiKey) {
			const res = await fetchFn(
				`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
				{ signal: AbortSignal.timeout(3500) },
			);
			if (!res.ok) return getDynamicProviderModels(providerId);
			const payload = (await res.json()) as {
				models?: Array<{
					name?: string;
					displayName?: string;
					inputTokenLimit?: number;
					outputTokenLimit?: number;
					supportedGenerationMethods?: string[];
					thinking?: boolean;
				}>;
			};
			const discovered: Model<Api>[] = [];
			for (const entry of payload.models ?? []) {
				const rawName = typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : "";
				if (!rawName || !isGoogleChatCandidate(rawName, entry.supportedGenerationMethods)) continue;
				const reasoning = typeof entry.thinking === "boolean"
					? entry.thinking
					: !/flash-lite|1\.5|2\.0-flash(?!-thinking)/i.test(rawName);
				discovered.push({
					id: rawName,
					name: typeof entry.displayName === "string" && entry.displayName.trim() ? entry.displayName.trim() : formatModelDisplayName(rawName),
					api: "google-generative-ai",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					reasoning,
					input: ["text", "image"],
					cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
					contextWindow: typeof entry.inputTokenLimit === "number" && entry.inputTokenLimit > 0 ? entry.inputTokenLimit : 1_048_576,
					maxTokens: typeof entry.outputTokenLimit === "number" && entry.outputTokenLimit > 0 ? entry.outputTokenLimit : 65_536,
					...(reasoning ? { thinkingLevelMap: { ...GOOGLE_THINKING_LEVEL_MAP } } : {}),
					inputLimits: GOOGLE_INPUT_LIMITS,
				});
			}
			registerDynamicProviderModels("google", discovered);
			return discovered;
		}

		if (providerId === "openrouter") {
			const res = await fetchFn("https://openrouter.ai/api/v1/models", {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
				signal: AbortSignal.timeout(3500),
			});
			if (!res.ok) return getDynamicProviderModels(providerId);
			const payload = (await res.json()) as {
				data?: Array<{
					id?: string;
					name?: string;
					context_length?: number;
					top_provider?: { max_completion_tokens?: number };
					architecture?: { input_modalities?: string[]; modality?: string };
					pricing?: { prompt?: string; completion?: string };
					supported_parameters?: string[];
				}>;
			};
			const discovered: Model<Api>[] = [];
			for (const entry of payload.data ?? []) {
				if (typeof entry.id !== "string" || !entry.id) continue;
				const modalities = entry.architecture?.input_modalities ?? [];
				const hasImage = modalities.includes("image") || String(entry.architecture?.modality ?? "").includes("image");
				const reasoning = Array.isArray(entry.supported_parameters)
					? entry.supported_parameters.includes("reasoning") || entry.supported_parameters.includes("include_reasoning")
					: /(thinking|reasoning|claude|gpt-5|gpt-6|gemini-2\.5|gemini-3|gemini-4|o1|o3|o4|deepseek-r1)/i.test(entry.id);
				const inputCost = Number.parseFloat(entry.pricing?.prompt ?? "0") * 1_000_000;
				const outputCost = Number.parseFloat(entry.pricing?.completion ?? "0") * 1_000_000;
				discovered.push({
					id: entry.id,
					name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : entry.id,
					api: "openai-completions",
					provider: "openrouter",
					baseUrl: "https://openrouter.ai/api/v1",
					reasoning,
					input: hasImage ? ["text", "image"] : ["text"],
					cost: {
						input: Number.isFinite(inputCost) ? inputCost : 0,
						output: Number.isFinite(outputCost) ? outputCost : 0,
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: typeof entry.context_length === "number" && entry.context_length > 0 ? entry.context_length : 128_000,
					maxTokens: typeof entry.top_provider?.max_completion_tokens === "number" && entry.top_provider.max_completion_tokens > 0
						? entry.top_provider.max_completion_tokens
						: 32_768,
				});
			}
			registerDynamicProviderModels("openrouter", discovered);
			return discovered;
		}
	} catch {
		// Best-effort network probe: static + supplemental catalog stays intact offline.
	}

	return getDynamicProviderModels(providerId);
}

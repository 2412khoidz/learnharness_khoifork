import fs from "node:fs";
import path from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { PATHS } from "../../config.ts";

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

const CARBON_THINKING_LEVEL_MAP = {
	...GOOGLE_THINKING_LEVEL_MAP,
	xhigh: "xhigh",
};

const OPENAI_THINKING_LEVEL_MAP = {
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const OPENAI_PRO_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const OPENAI_INPUT_LIMITS = {
	maxRequestBytes: 536_870_912,
	images: {
		maxPerRequest: 1500,
		resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 },
	},
};

function makeOpenAIResponsesModel(
	id: string,
	name: string,
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
	thinkingLevelMap: Record<string, string | null> = OPENAI_THINKING_LEVEL_MAP,
): Model<Api> {
	return {
		id,
		name,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost,
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...thinkingLevelMap },
		compat: {
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: true,
			supportsAdditionalTools: true,
			supportsToolSearch: true,
			supportsMidConvoSystemMessages: true,
			supportsExplicitPromptCacheMode: true,
			supportsMidConvoEffort: true,
		},
		inputLimits: OPENAI_INPUT_LIMITS,
	} as Model<Api>;
}

function makeCopilotResponsesModel(
	id: string,
	name: string,
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
	thinkingLevelMap: Record<string, string | null> = OPENAI_THINKING_LEVEL_MAP,
): Model<Api> {
	return {
		id,
		name,
		api: "openai-responses",
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost,
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...thinkingLevelMap },
		headers: { ...COPILOT_HEADERS },
		inputLimits: VERTEX_INPUT_LIMITS,
	} as Model<Api>;
}

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
		{
			id: "gemini-4-carbon",
			name: "Gemini 4 Carbon",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...CARBON_THINKING_LEVEL_MAP },
			inputLimits: GOOGLE_INPUT_LIMITS,
		},
		{
			id: "gemini-4-neon",
			name: "Gemini 4 Neon",
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
		{
			id: "gemini-4-argon",
			name: "Gemini 4 Argon",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0 },
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
		{
			id: "gemini-4-carbon",
			name: "Gemini 4 Carbon",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://{location}-aiplatform.googleapis.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...CARBON_THINKING_LEVEL_MAP },
			inputLimits: VERTEX_INPUT_LIMITS,
		},
		{
			id: "gemini-4-neon",
			name: "Gemini 4 Neon",
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
		{
			id: "gemini-4-argon",
			name: "Gemini 4 Argon",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://{location}-aiplatform.googleapis.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...GOOGLE_THINKING_LEVEL_MAP },
			inputLimits: VERTEX_INPUT_LIMITS,
		},
	],
	openai: [
		makeOpenAIResponsesModel("gpt-6.2-astra", "GPT-6.2 Astra", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.2-astra-pro", "GPT-6.2 Astra Pro", { input: 20, output: 100, cacheRead: 2, cacheWrite: 25 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.2-sol", "GPT-6.2 Sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, OPENAI_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.2-sol-pro", "GPT-6.2 Sol Pro", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.2-terra", "GPT-6.2 Terra", { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 }, OPENAI_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.2-terra-pro", "GPT-6.2 Terra Pro", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.2-luna", "GPT-6.2 Luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, OPENAI_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.2-luna-pro", "GPT-6.2 Luna Pro", { input: 0.2, output: 1.0, cacheRead: 0.02, cacheWrite: 0.25 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.1-terra-pro", "GPT-6.1 Terra Pro", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6.1-sol-pro", "GPT-6.1 Sol Pro", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6-astra-pro", "GPT-6 Astra Pro", { input: 20, output: 100, cacheRead: 2, cacheWrite: 25 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6-sol-pro", "GPT-6 Sol Pro", { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeOpenAIResponsesModel("gpt-6-luna-pro", "GPT-6 Luna Pro", { input: 0.2, output: 1.0, cacheRead: 0.02, cacheWrite: 0.25 }, OPENAI_PRO_THINKING_LEVEL_MAP),
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
		{
			id: "gemini-4-carbon",
			name: "Gemini 4 Carbon",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...CARBON_THINKING_LEVEL_MAP },
			headers: { ...COPILOT_HEADERS },
			compat: {
				supportsStrictMode: true,
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
			inputLimits: VERTEX_INPUT_LIMITS,
		},
		{
			id: "gemini-4-neon",
			name: "Gemini 4 Neon",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...GOOGLE_THINKING_LEVEL_MAP },
			headers: { ...COPILOT_HEADERS },
			compat: {
				supportsStrictMode: true,
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
			inputLimits: VERTEX_INPUT_LIMITS,
		},
		{
			id: "gemini-4-argon",
			name: "Gemini 4 Argon",
			api: "openai-completions",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
			thinkingLevelMap: { ...GOOGLE_THINKING_LEVEL_MAP },
			headers: { ...COPILOT_HEADERS },
			compat: {
				supportsStrictMode: true,
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
			},
			inputLimits: VERTEX_INPUT_LIMITS,
		},
		makeCopilotResponsesModel("gpt-6.2-astra", "GPT-6.2 Astra", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeCopilotResponsesModel("gpt-6.2-astra-pro", "GPT-6.2 Astra Pro", { input: 20, output: 100, cacheRead: 2, cacheWrite: 25 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeCopilotResponsesModel("gpt-6.2-sol", "GPT-6.2 Sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, OPENAI_THINKING_LEVEL_MAP),
		makeCopilotResponsesModel("gpt-6.2-sol-pro", "GPT-6.2 Sol Pro", { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
		makeCopilotResponsesModel("gpt-6.2-terra", "GPT-6.2 Terra", { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 }, OPENAI_THINKING_LEVEL_MAP),
		makeCopilotResponsesModel("gpt-6.2-luna", "GPT-6.2 Luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, OPENAI_THINKING_LEVEL_MAP),
		makeCopilotResponsesModel("gpt-6.1-terra", "GPT-6.1 Terra", { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 }, OPENAI_THINKING_LEVEL_MAP),
		makeCopilotResponsesModel("gpt-6.1-sol", "GPT-6.1 Sol", { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, OPENAI_PRO_THINKING_LEVEL_MAP),
	],
};

export interface LiveModelSpec {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: Record<string, string | null>;
}

interface PersistedLiveModelState {
	customModels: Record<string, LiveModelSpec[]>;
	pausedProviders: string[];
	discoveredModels: Record<string, LiveModelSpec[]>;
}

const DYNAMIC_KEY = Symbol.for("lh.live.models.registry");
interface DynamicState {
	modelsByProvider: Map<string, Map<string, Model<Api>>>;
	customSpecsByProvider: Map<string, Map<string, LiveModelSpec>>;
	pausedProviders: Set<string>;
	lastProbeAt: Map<string, number>;
	persistenceLoaded: boolean;
	cachePathOverride?: string | null;
}

function registry(): DynamicState {
	const g = globalThis as typeof globalThis & { [DYNAMIC_KEY]?: DynamicState };
	if (!g[DYNAMIC_KEY]) {
		g[DYNAMIC_KEY] = {
			modelsByProvider: new Map(),
			customSpecsByProvider: new Map(),
			pausedProviders: new Set(),
			lastProbeAt: new Map(),
			persistenceLoaded: false,
		};
	}
	return g[DYNAMIC_KEY];
}

function defaultLiveModelsCachePath(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "live-models-cache.json");
}

function activeCachePath(state: DynamicState): string | null {
	if (state.cachePathOverride !== undefined) return state.cachePathOverride;
	if (process.env.NODE_ENV === "test") return null;
	return defaultLiveModelsCachePath();
}

function synthesizeModelFromSpec(providerId: string, spec: LiveModelSpec, template?: Model<Api>): Model<Api> {
	const id = spec.id.trim();
	const name = spec.name?.trim() || formatModelDisplayName(id);
	const reasoning = spec.reasoning ?? true;
	const input: ("text" | "image")[] = spec.input?.length ? [...spec.input] : ["text", "image"];
	const contextWindow = typeof spec.contextWindow === "number" && spec.contextWindow > 0 ? spec.contextWindow : 1_048_576;
	const maxTokens = typeof spec.maxTokens === "number" && spec.maxTokens > 0 ? spec.maxTokens : 65_536;
	const tMap = spec.thinkingLevelMap
		? { ...spec.thinkingLevelMap }
		: reasoning
			? { ...CARBON_THINKING_LEVEL_MAP }
			: undefined;

	if (template) {
		return {
			...template,
			id,
			name,
			provider: providerId,
			reasoning,
			input,
			contextWindow,
			maxTokens,
			...(tMap ? { thinkingLevelMap: tMap } : {}),
		};
	}

	if (providerId === "google") {
		return {
			id,
			name,
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			reasoning,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			...(tMap ? { thinkingLevelMap: tMap } : {}),
			inputLimits: GOOGLE_INPUT_LIMITS,
		};
	}
	if (providerId === "google-vertex") {
		return {
			id,
			name,
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: "https://{location}-aiplatform.googleapis.com",
			reasoning,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			...(tMap ? { thinkingLevelMap: tMap } : {}),
			inputLimits: VERTEX_INPUT_LIMITS,
		};
	}
	if (providerId === "anthropic") {
		return {
			id,
			name,
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			...(tMap ? { thinkingLevelMap: tMap } : {}),
		};
	}
	if (providerId === "openai" || providerId === "chatgpt") {
		return {
			id,
			name,
			api: "openai-responses",
			provider: providerId,
			baseUrl: "https://api.openai.com/v1",
			reasoning,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			...(tMap ? { thinkingLevelMap: tMap } : {}),
		};
	}
	if (providerId === "github-copilot" || providerId === "github-copilot-subscription") {
		const isClaude = id.startsWith("claude-");
		return {
			id,
			name,
			api: isClaude ? "anthropic-messages" : "openai-completions",
			provider: providerId,
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning,
			input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			...(tMap ? { thinkingLevelMap: tMap } : {}),
			headers: { ...COPILOT_HEADERS },
			...(!isClaude
				? {
						compat: {
							supportsStrictMode: true,
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					}
				: {}),
			inputLimits: VERTEX_INPUT_LIMITS,
		};
	}

	return {
		id,
		name,
		api: "openai-completions",
		provider: providerId,
		baseUrl: providerId === "openrouter" ? "https://openrouter.ai/api/v1" : "",
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
		...(tMap ? { thinkingLevelMap: tMap } : {}),
	};
}

function modelToSpec(model: Model<Api>): LiveModelSpec {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: [...model.input],
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		...((model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap
			? { thinkingLevelMap: { ...(model as { thinkingLevelMap: Record<string, string | null> }).thinkingLevelMap } }
			: {}),
	};
}

function ensurePersistenceLoaded(): void {
	const state = registry();
	if (state.persistenceLoaded) return;
	state.persistenceLoaded = true;
	const filePath = activeCachePath(state);
	if (!filePath) return;
	try {
		if (!fs.existsSync(/* turbopackIgnore: true */ filePath)) return;
		const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8")) as Partial<PersistedLiveModelState>;
		if (Array.isArray(parsed.pausedProviders)) {
			for (const p of parsed.pausedProviders) {
				if (typeof p === "string" && p.trim()) state.pausedProviders.add(p.trim());
			}
		}
		if (parsed.discoveredModels && typeof parsed.discoveredModels === "object") {
			for (const [providerId, specs] of Object.entries(parsed.discoveredModels)) {
				if (!Array.isArray(specs)) continue;
				const synthesized = specs
					.filter((s): s is LiveModelSpec => !!s && typeof s.id === "string" && s.id.trim().length > 0)
					.map((s) => synthesizeModelFromSpec(providerId, s));
				registerDynamicProviderModels(providerId, synthesized);
			}
		}
		if (parsed.customModels && typeof parsed.customModels === "object") {
			for (const [providerId, specs] of Object.entries(parsed.customModels)) {
				if (!Array.isArray(specs)) continue;
				let customMap = state.customSpecsByProvider.get(providerId);
				if (!customMap) {
					customMap = new Map();
					state.customSpecsByProvider.set(providerId, customMap);
				}
				const synthesized: Model<Api>[] = [];
				for (const s of specs) {
					if (!s || typeof s.id !== "string" || !s.id.trim()) continue;
					const normalizedSpec: LiveModelSpec = { ...s, id: s.id.trim() };
					customMap.set(normalizedSpec.id, normalizedSpec);
					synthesized.push(synthesizeModelFromSpec(providerId, normalizedSpec));
				}
				if (synthesized.length > 0) registerDynamicProviderModels(providerId, synthesized);
			}
		}
	} catch {
		// Ignore malformed cache files and treat as empty persistence state.
	}
}

function persistState(): void {
	const state = registry();
	const filePath = activeCachePath(state);
	if (!filePath) return;
	const customModels: Record<string, LiveModelSpec[]> = {};
	for (const [providerId, specs] of state.customSpecsByProvider.entries()) {
		if (specs.size > 0) customModels[providerId] = [...specs.values()];
	}
	const discoveredModels: Record<string, LiveModelSpec[]> = {};
	for (const [providerId, bucket] of state.modelsByProvider.entries()) {
		const customIds = state.customSpecsByProvider.get(providerId);
		const discovered = [...bucket.values()].filter((m) => !customIds?.has(m.id)).map(modelToSpec);
		if (discovered.length > 0) discoveredModels[providerId] = discovered;
	}
	const payload: PersistedLiveModelState = {
		customModels,
		pausedProviders: [...state.pausedProviders],
		discoveredModels,
	};
	try {
		fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(/* turbopackIgnore: true */ filePath), { recursive: true });
		fs.writeFileSync(/* turbopackIgnore: true */ filePath, JSON.stringify(payload, null, 2), "utf8");
	} catch {
		// Best-effort disk cache write.
	}
}

/** Isolate cache persistence during unit tests. */
export function setLiveModelsCachePathForTests(filePath: string | null): void {
	const state = registry();
	state.cachePathOverride = filePath;
	state.customSpecsByProvider.clear();
	state.pausedProviders.clear();
	state.lastProbeAt.clear();
	state.modelsByProvider.clear();
	state.persistenceLoaded = false;
	if (filePath !== null) ensurePersistenceLoaded();
}

export function addCustomProviderModel(providerId: string, spec: LiveModelSpec, template?: Model<Api>): Model<Api> {
	const trimmedProvider = providerId.trim();
	const trimmedId = spec.id.trim();
	if (!trimmedProvider) throw new Error("Provider ID is required");
	if (!trimmedId) throw new Error("Model ID is required");
	ensurePersistenceLoaded();
	const state = registry();
	const normalizedSpec: LiveModelSpec = { ...spec, id: trimmedId };
	let customMap = state.customSpecsByProvider.get(trimmedProvider);
	if (!customMap) {
		customMap = new Map();
		state.customSpecsByProvider.set(trimmedProvider, customMap);
	}
	customMap.set(trimmedId, normalizedSpec);
	const model = synthesizeModelFromSpec(trimmedProvider, normalizedSpec, template);
	registerDynamicProviderModels(trimmedProvider, [model]);
	persistState();
	return model;
}

export function removeCustomProviderModel(providerId: string, modelId: string): boolean {
	ensurePersistenceLoaded();
	const state = registry();
	const customMap = state.customSpecsByProvider.get(providerId);
	if (!customMap || !customMap.has(modelId)) return false;
	customMap.delete(modelId);
	if (customMap.size === 0) state.customSpecsByProvider.delete(providerId);
	state.modelsByProvider.get(providerId)?.delete(modelId);
	persistState();
	return true;
}

export function getCustomProviderModels(providerId?: string): Record<string, LiveModelSpec[]> {
	ensurePersistenceLoaded();
	const state = registry();
	if (providerId !== undefined) {
		const map = state.customSpecsByProvider.get(providerId);
		return map && map.size > 0 ? { [providerId]: [...map.values()] } : {};
	}
	const out: Record<string, LiveModelSpec[]> = {};
	for (const [id, map] of state.customSpecsByProvider.entries()) {
		if (map.size > 0) out[id] = [...map.values()];
	}
	return out;
}

export function isProviderPaused(providerId: string): boolean {
	ensurePersistenceLoaded();
	return registry().pausedProviders.has(providerId);
}

export function setProviderPaused(providerId: string, paused: boolean): void {
	const trimmed = providerId.trim();
	if (!trimmed) throw new Error("Provider ID is required");
	ensurePersistenceLoaded();
	const state = registry();
	if (paused) state.pausedProviders.add(trimmed);
	else state.pausedProviders.delete(trimmed);
	persistState();
}

export function getPausedProviders(): string[] {
	ensurePersistenceLoaded();
	return [...registry().pausedProviders].sort();
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
	ensurePersistenceLoaded();
	const bucket = registry().modelsByProvider.get(providerId);
	return bucket ? [...bucket.values()] : [];
}

/** Merge static provider models with supplemental and live-discovered entries (static wins on id conflict). */
export function augmentProviderModels<TApi extends Api = Api>(
	providerId: string,
	baseModels: readonly Model<TApi>[],
): Model<Api>[] {
	ensurePersistenceLoaded();
	const merged = new Map<string, Model<Api>>();
	for (const model of baseModels) {
		merged.set(model.id, model as Model<Api>);
	}
	for (const extra of SUPPLEMENTAL_MODELS[providerId] ?? []) {
		if (!merged.has(extra.id)) merged.set(extra.id, extra);
	}
	const sample = baseModels[0] as Model<Api> | undefined;
	for (const live of getDynamicProviderModels(providerId)) {
		if (merged.has(live.id)) continue;
		if (!live.baseUrl && sample) {
			merged.set(live.id, {
				...sample,
				id: live.id,
				name: live.name,
				provider: providerId,
				reasoning: live.reasoning,
				input: live.input,
				contextWindow: live.contextWindow,
				maxTokens: live.maxTokens,
			});
		} else {
			merged.set(live.id, live);
		}
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

function keyFingerprint(apiKey: string | undefined): string {
	if (!apiKey) return "anon";
	return `${apiKey.slice(0, 6)}:${apiKey.slice(-4)}:${apiKey.length}`;
}

/**
 * Probe provider `/models` endpoints (currently Google Gemini API & OpenRouter)
 * with a short timeout and 5-minute TTL cache so newly released provider models
 * become selectable without requiring an app update.
 */
export async function probeLiveProviderModels(
	providerId: string,
	apiKey: string | undefined,
	options: { force?: boolean; allowNetworkInTest?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<Model<Api>[]> {
	ensurePersistenceLoaded();
	if (!options.force && !options.allowNetworkInTest && (process.env.NODE_ENV === "test" || process.env.LH_LIVE_MODELS === "0")) {
		return getDynamicProviderModels(providerId);
	}
	if (!apiKey && providerId !== "openrouter") return [];

	const state = registry();
	const now = Date.now();
	const probeKey = `${providerId}:${keyFingerprint(apiKey)}`;
	const last = state.lastProbeAt.get(probeKey) ?? 0;
	if (!options.force && now - last < PROBE_TTL_MS) {
		return getDynamicProviderModels(providerId);
	}
	state.lastProbeAt.set(probeKey, now);

	const fetchFn = options.fetchImpl ?? globalThis.fetch;
	if (typeof fetchFn !== "function") return getDynamicProviderModels(providerId);

	try {
		if (providerId === "google" && apiKey) {
			const discovered: Model<Api>[] = [];
			let pageToken: string | undefined;
			let firstPageOk = true;
			for (let page = 0; page < 3; page++) {
				const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
				const res = await fetchFn(url, { signal: AbortSignal.timeout(3500) });
				if (!res.ok) {
					if (page === 0) firstPageOk = false;
					break;
				}
				const payload = (await res.json()) as {
					models?: Array<{
						name?: string;
						displayName?: string;
						inputTokenLimit?: number;
						outputTokenLimit?: number;
						supportedGenerationMethods?: string[];
						thinking?: boolean;
					}>;
					nextPageToken?: string;
				};
				for (const entry of payload.models ?? []) {
					const rawName = typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : "";
					if (!rawName || !isGoogleChatCandidate(rawName, entry.supportedGenerationMethods)) continue;
					const reasoning = typeof entry.thinking === "boolean"
						? entry.thinking
						: !/flash-lite|1\.5|2\.0-flash(?!-thinking)/i.test(rawName);
					const tMap = /carbon/i.test(rawName) ? { ...CARBON_THINKING_LEVEL_MAP } : { ...GOOGLE_THINKING_LEVEL_MAP };
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
						...(reasoning ? { thinkingLevelMap: tMap } : {}),
						inputLimits: GOOGLE_INPUT_LIMITS,
					});
				}
				if (!payload.nextPageToken) break;
				pageToken = payload.nextPageToken;
			}
			if (!firstPageOk) return getDynamicProviderModels(providerId);
			registerDynamicProviderModels("google", discovered);
			persistState();
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
			persistState();
			return discovered;
		}
	} catch {
		// Best-effort network probe: static + supplemental catalog stays intact offline.
	}

	return getDynamicProviderModels(providerId);
}

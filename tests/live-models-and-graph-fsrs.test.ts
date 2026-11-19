import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModels, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { piModels } from "../src/agent/models.ts";
import { probeLiveProviderModels } from "../src/agent/live-models.ts";
import { computeGraphFsrsSummary } from "../src/core/fsrs-graph.ts";
import { readGraphFsrsSummary } from "../src/server/graph-fsrs.ts";
import type { GraphSnapshot } from "../src/core/contracts.ts";

const require = createRequire(import.meta.url);
const { createSubscriptions } = require("../electron/subscriptions.cjs");

test("piModels exposes gemini-4-hydrogen, gemini-4-neon, and gemini-4-argon across google, google-vertex, and github-copilot, plus gpt-6.2 models", () => {
	const models = piModels();
	for (const modelId of ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-argon"] as const) {
		for (const providerId of ["google", "google-vertex", "github-copilot"] as const) {
			const model = models.getModel(providerId, modelId);
			assert.ok(model, `expected ${providerId}/${modelId} to exist`);
			assert.equal(model.reasoning, true);
			assert.equal(model.contextWindow, 1_048_576);
		}
	}
	for (const modelId of ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.2-terra", "gpt-6.2-luna"] as const) {
		for (const providerId of ["openai", "github-copilot"] as const) {
			const model = models.getModel(providerId, modelId);
			assert.ok(model, `expected ${providerId}/${modelId} to exist`);
			assert.equal(model.reasoning, true);
		}
	}
});

test("probeLiveProviderModels discovers new Google models and injects them into piModels", async () => {
	const fetchImpl: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				models: [
					{
						name: "models/gemini-4.5-ultra",
						displayName: "Gemini 4.5 Ultra",
						inputTokenLimit: 2_000_000,
						outputTokenLimit: 65_536,
						supportedGenerationMethods: ["generateContent"],
						thinking: true,
					},
					{
						name: "models/text-embedding-004",
						supportedGenerationMethods: ["embedContent"],
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);

	const discovered = await probeLiveProviderModels("google", "test-key", { force: true, fetchImpl });
	assert.equal(discovered.length, 1);
	assert.equal(discovered[0]!.id, "gemini-4.5-ultra");

	const model = piModels().getModel("google", "gemini-4.5-ultra");
	assert.ok(model, "expected probed model in piModels()");
	assert.equal(model.name, "Gemini 4.5 Ultra");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 2_000_000);
	assert.equal(piModels().getModel("google", "text-embedding-004"), undefined);
});

test("Copilot subscription catalog keeps gemini-4-hydrogen and newly entitled chat models while skipping embeddings", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-live-copilot-"));
	const copilotCred: OAuthCredential = {
		type: "oauth",
		access: "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;",
		refresh: "fixture-refresh",
		expires: Date.now() + 3_600_000,
		availableModelIds: ["gemini-4-hydrogen", "gpt-7-future-preview", "text-embedding-3-large"],
	};
	const nativeCopilot = githubCopilotProvider();
	const nativeXai = xaiProvider();
	const sdk = {
		createModels,
		githubCopilotProvider: () => ({
			...nativeCopilot,
			auth: {
				...nativeCopilot.auth,
				oauth: {
					...nativeCopilot.auth.oauth!,
					login: async (_interaction: ProviderAuthInteraction) => copilotCred,
					refresh: async (cred: OAuthCredential) => cred,
				},
			},
		}),
		xaiProvider: () => nativeXai,
	};

	const controller = createSubscriptions({
		directory,
		sdk,
		openExternal: async () => {},
		onChange: () => {},
	});

	try {
		await controller.ready;
		await controller.login("github-copilot", true);
		const snap = await controller.snapshot();
		const models = snap.models["github-copilot"] ?? [];
		const modelIds = models.map((m: { id: string }) => m.id);

		assert.ok(modelIds.includes("gemini-4-hydrogen"), "expected gemini-4-hydrogen in Copilot catalog");
		assert.ok(modelIds.includes("gpt-7-future-preview"), "expected newly entitled chat model synthesized in catalog");
		assert.ok(!modelIds.includes("text-embedding-3-large"), "expected embedding model excluded from chat catalog");

		const status = snap.statuses.find((s: { providerId: string }) => s.providerId === "github-copilot");
		assert.ok(status);

		for (const selectedModelId of ["gemini-4-hydrogen", "gpt-7-future-preview"]) {
			const lease = await controller.lease(
				{
					providerId: "github-copilot",
					connectionId: status.connectionId,
					epoch: status.epoch,
					authorityRevision: status.authorityRevision,
					selectedModelId,
				},
				true,
			);
			assert.equal(lease.auth.apiKey, copilotCred.access);
		}
	} finally {
		controller.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("computeGraphFsrsSummary & readGraphFsrsSummary classify memory bands and propagate weakPrerequisites", async () => {
	const DAY = 86_400_000;
	const now = Date.UTC(2026, 10, 14, 12, 0, 0);
	const ts = "2026-11-01T00:00:00.000Z";
	const snapshot: Pick<GraphSnapshot, "nodes" | "chains"> = {
		nodes: [
			{ id: "n_strong", name: "Strong Premise", statement: "Always remembered", aliases: [], createdAt: ts, provenance: [] },
			{ id: "n_decay", name: "Decaying Premise", statement: "Fading gradually", aliases: [], createdAt: ts, provenance: [] },
			{ id: "n_overdue", name: "Overdue Premise", statement: "Needs review", aliases: [], createdAt: ts, provenance: [] },
			{ id: "n_target_strong", name: "Derived Theorem", statement: "Depends on Overdue Premise", aliases: [], createdAt: ts, provenance: [] },
			{ id: "n_target_untracked", name: "Untracked Corollary", statement: "Depends on Decaying Premise", aliases: [], createdAt: ts, provenance: [] },
		],
		chains: [
			{ id: "arg_1", premises: ["n_overdue"], conclusion: "n_target_strong", provenance: [], createdAt: ts },
			{ id: "arg_2", premises: ["n_decay"], conclusion: "n_target_untracked", provenance: [], createdAt: ts },
		],
	};

	const flashcardsStore = {
		settings: { dayStart: 4 },
		propositions: {
			n_strong: {
				id: "n_strong",
				cues: [{ deleted: false }],
				schedule: {
					state: 2,
					stability: 30,
					difficulty: 4.5,
					reps: 4,
					lapses: 0,
					last_review: now - 1 * DAY,
					due: now + 20 * DAY,
					dueDay: "2026-12-04",
				},
			},
			n_decay: {
				id: "n_decay",
				cues: [{ deleted: false }],
				schedule: {
					state: 2,
					stability: 10,
					difficulty: 5.0,
					reps: 3,
					lapses: 0,
					last_review: now - 15 * DAY,
					due: now + 5 * DAY,
					dueDay: "2026-11-19",
				},
			},
			n_overdue: {
				id: "n_overdue",
				cues: [{ deleted: false }],
				schedule: {
					state: 2,
					stability: 5,
					difficulty: 6.2,
					reps: 2,
					lapses: 1,
					last_review: now - 12 * DAY,
					due: now - 2 * DAY,
					dueDay: "2026-11-12",
				},
			},
			n_target_strong: {
				id: "n_target_strong",
				cues: [{ deleted: false }],
				schedule: {
					state: 2,
					stability: 40,
					difficulty: 3.8,
					reps: 5,
					lapses: 0,
					last_review: now - 1 * DAY,
					due: now + 30 * DAY,
					dueDay: "2026-12-14",
				},
			},
		},
		reviews: [{}, {}],
	};

	const summary = computeGraphFsrsSummary(snapshot, flashcardsStore, now);
	assert.equal(summary.nodes.n_strong?.memoryBand, "strong");
	assert.equal(summary.nodes.n_decay?.memoryBand, "decaying");
	assert.equal(summary.nodes.n_overdue?.memoryBand, "overdue");
	assert.equal(summary.nodes.n_overdue?.due, true);
	assert.equal(summary.nodes.n_target_strong?.memoryBand, "strong");
	assert.deepEqual(
		summary.nodes.n_target_strong?.weakPrerequisites.map((w) => w.id),
		["n_overdue"],
	);
	// n_decay retrievability at 15d with S=10 is ~0.87 (decaying >= 0.80), so verify strong (< 0.80 check):
	// Let's make sure when R < 0.80 it triggers weakPrerequisites on untracked node too.
	assert.equal(summary.counts.tracked, 4);
	assert.equal(summary.counts.strong, 2);
	assert.equal(summary.counts.decaying, 1);
	assert.equal(summary.counts.overdue, 1);
	assert.equal(summary.counts.prereqRisk, 1);
	assert.equal(summary.reviewCount, 2);

	// Also verify weak premise with R < 0.80 propagates even to untracked node when read from disk
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-graph-fsrs-"));
	try {
		flashcardsStore.propositions.n_decay.schedule.last_review = now - 35 * DAY;
		const file = path.join(dir, "flashcards.json");
		await fs.writeFile(file, JSON.stringify(flashcardsStore), "utf8");
		const fromDisk = readGraphFsrsSummary(snapshot, file, now);
		assert.equal(fromDisk.nodes.n_decay?.memoryBand, "decaying");
		assert.ok((fromDisk.nodes.n_decay?.retrievability ?? 1) < 0.8);
		assert.equal(fromDisk.nodes.n_target_untracked?.memoryBand, "untracked");
		assert.deepEqual(
			fromDisk.nodes.n_target_untracked?.weakPrerequisites.map((w) => w.id),
			["n_decay"],
		);
		assert.equal(fromDisk.counts.prereqRisk, 2);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createModels, getSupportedThinkingLevels, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { piModels } from "../src/agent/models.ts";
import {
	addCustomProviderModel,
	isProviderPaused,
	probeLiveProviderModels,
	removeCustomProviderModel,
	setLiveModelsCachePathForTests,
	setProviderPaused,
} from "../src/agent/live-models.ts";
import { practiceTools } from "../src/agent/tools/practice.ts";
import {
	computeExamPrepStatus,
	computeGraphFsrsSummary,
	DEFAULT_EXAM_PREP_CONFIG,
	formatTemporalGapNote,
	toLlmMessages,
	type GraphSnapshot,
} from "../src/core/index.ts";
import {
	catalogProviders,
	readExamPrepConfig,
	readExamPrepStatus,
	recordPracticeFsrsOutcome,
	writeExamPrepConfig,
} from "../src/server/index.ts";

const require = createRequire(import.meta.url);
const { createSubscriptions } = require("../electron/subscriptions.cjs");

test("piModels and Copilot subscription catalog expose gemini-4-carbon with xhigh thinking", async () => {
	const models = piModels();
	for (const providerId of ["google", "google-vertex", "github-copilot"] as const) {
		const model = models.getModel(providerId, "gemini-4-carbon");
		assert.ok(model, `expected ${providerId}/gemini-4-carbon to exist`);
		assert.equal(model.name, "Gemini 4 Carbon");
		assert.equal(model.contextWindow, 1_048_576);
		if (providerId !== "github-copilot") {
			const levels = getSupportedThinkingLevels(model);
			assert.ok(levels.includes("xhigh"), `expected ${providerId}/gemini-4-carbon to support xhigh`);
		}
	}

	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lh-carbon-copilot-"));
	const copilotCred: OAuthCredential = {
		type: "oauth",
		access: "tid=fixture;proxy-ep=proxy.individual.githubcopilot.com;",
		refresh: "fixture-refresh",
		expires: Date.now() + 3_600_000,
		availableModelIds: ["gemini-4-carbon"],
	};
	const nativeCopilot = githubCopilotProvider();
	const nativeXai = xaiProvider();
	const controller = createSubscriptions({
		directory,
		sdk: {
			createModels,
			githubCopilotProvider: () => ({
				...nativeCopilot,
				auth: {
					...nativeCopilot.auth,
					oauth: {
						...nativeCopilot.auth.oauth!,
						login: async (_i: ProviderAuthInteraction) => copilotCred,
						refresh: async (c: OAuthCredential) => c,
					},
				},
			}),
			xaiProvider: () => nativeXai,
		},
		openExternal: async () => {},
		onChange: () => {},
	});
	try {
		await controller.ready;
		await controller.login("github-copilot", true);
		const snap = await controller.snapshot();
		const ids = (snap.models["github-copilot"] ?? []).map((m: { id: string }) => m.id);
		assert.ok(ids.includes("gemini-4-carbon"));
	} finally {
		controller.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("Custom model ID persistence, provider pause/resume, Google pagination, and API-key cooldown invalidation", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-live-cache-"));
	const cacheFile = path.join(dir, "live-models-cache.json");
	setLiveModelsCachePathForTests(cacheFile);
	try {
		const added = addCustomProviderModel("google", { id: "gemini-5-quartz", name: "Gemini 5 Quartz", reasoning: true });
		assert.equal(added.id, "gemini-5-quartz");
		assert.ok(piModels().getModel("google", "gemini-5-quartz"));

		setProviderPaused("google", true);
		assert.equal(isProviderPaused("google"), true);
		assert.equal(catalogProviders().some((p) => p.id === "google"), false);

		// Simulate process reload from persisted disk cache
		setLiveModelsCachePathForTests(cacheFile);
		assert.equal(isProviderPaused("google"), true);
		assert.ok(piModels().getModel("google", "gemini-5-quartz"));

		setProviderPaused("google", false);
		assert.equal(isProviderPaused("google"), false);
		assert.equal(catalogProviders().some((p) => p.id === "google"), true);

		assert.equal(removeCustomProviderModel("google", "gemini-5-quartz"), true);
		assert.equal(piModels().getModel("google", "gemini-5-quartz"), undefined);

		// Pagination + API key invalidation check
		let calls = 0;
		const fetchImpl: typeof fetch = async (input) => {
			calls++;
			const url = String(input);
			if (url.includes("pageToken=page2")) {
				return new Response(
					JSON.stringify({
						models: [
							{ name: "models/gemini-4.9-page2", supportedGenerationMethods: ["generateContent"], thinking: true },
						],
					}),
					{ status: 200 },
				);
			}
			return new Response(
				JSON.stringify({
					models: [
						{ name: "models/gemini-4.9-page1", supportedGenerationMethods: ["generateContent"], thinking: true },
					],
					nextPageToken: "page2",
				}),
				{ status: 200 },
			);
		};

		const pageModels = await probeLiveProviderModels("google", "key-alpha-1111", { allowNetworkInTest: true, fetchImpl });
		assert.equal(calls, 2);
		assert.deepEqual(pageModels.map((m) => m.id), ["gemini-4.9-page1", "gemini-4.9-page2"]);

		// Same API key hits TTL cache (no new fetch)
		await probeLiveProviderModels("google", "key-alpha-1111", { allowNetworkInTest: true, fetchImpl });
		assert.equal(calls, 2);

		// Changed API key bypasses cooldown immediately
		await probeLiveProviderModels("google", "key-beta-2222", { allowNetworkInTest: true, fetchImpl });
		assert.equal(calls, 4);
	} finally {
		setLiveModelsCachePathForTests(null);
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("Temporal gap awareness injects model-facing note without mutating stored messages", () => {
	const t0 = Date.UTC(2026, 10, 10, 9, 0, 0);
	const tShort = t0 + 2 * 3600 * 1000;
	const tMed = t0 + 6 * 3600 * 1000;
	const tLong = t0 + 50 * 3600 * 1000;

	assert.equal(formatTemporalGapNote(t0, tShort), null);
	assert.equal(
		formatTemporalGapNote(t0, tMed),
		"[Temporal note: 6h elapsed since the previous turn in this session.]",
	);
	assert.equal(
		formatTemporalGapNote(t0, tLong),
		"[Temporal note: 2d 2h elapsed since the previous turn in this session. Consider potential memory decay on earlier propositions.]",
	);

	const rawMessages = [
		{ id: "m1", role: "user", content: [{ type: "text", text: "First question" }], timestamp: t0 },
		{
			id: "m2",
			role: "assistant",
			content: [{ type: "text", text: "Explanation" }],
			api: "google-generative-ai",
			provider: "google",
			model: "gemini-4-carbon",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: t0 + 1000,
		},
		{ id: "m3", role: "user", content: [{ type: "text", text: "Returning after 2 days" }], timestamp: tLong },
	];

	const llm = toLlmMessages(rawMessages as never, { includeTemporalNotes: true });
	const third = llm[2] as { content: Array<{ type: string; text: string }> };
	assert.match(third.content[0]!.text, /^\[Temporal note: 2d 1h elapsed/);
	// Original record remains completely unmutated
	assert.equal((rawMessages[2]!.content[0] as { text: string }).text, "Returning after 2 days");
});

test("Foundation score, Exam Readiness %, and closed-loop Practice conclude FSRS-6 updates", async () => {
	const DAY = 86_400_000;
	const now = Date.UTC(2026, 10, 15, 12, 0, 0);
	const ts = "2026-11-01T00:00:00.000Z";
	const snapshot: Pick<GraphSnapshot, "nodes" | "chains"> = {
		nodes: [
			{ id: "n_root", name: "Axiom A", statement: "Root foundation", aliases: [], createdAt: ts, provenance: [] },
			{ id: "n_mid", name: "Lemma B", statement: "Derived from A", aliases: [], createdAt: ts, provenance: [] },
			{ id: "n_leaf", name: "Theorem C", statement: "Derived from B", aliases: [], createdAt: ts, provenance: [] },
			{ id: "n_untracked_found", name: "Untracked Axiom D", statement: "Supports leaf", aliases: [], createdAt: ts, provenance: [] },
		],
		chains: [
			{ id: "c1", premises: ["n_root"], conclusion: "n_mid", provenance: [], createdAt: ts },
			{ id: "c2", premises: ["n_mid"], conclusion: "n_leaf", provenance: [], createdAt: ts },
			{ id: "c3", premises: ["n_untracked_found"], conclusion: "n_leaf", provenance: [], createdAt: ts },
		],
	};

	const flashcardsStore = {
		settings: { dayStart: 4, retention: 0.9 },
		propositions: {
			n_root: {
				id: "n_root",
				cues: [{ id: "q1", question: "Q1", answer: "A1", deleted: false }],
				schedule: { state: 2, stability: 20, difficulty: 4.0, reps: 4, lapses: 0, last_review: now - 5 * DAY, due: now + 10 * DAY, dueDay: "2026-11-25" },
			},
			n_mid: {
				id: "n_mid",
				cues: [{ id: "q2", question: "Q2", answer: "A2", deleted: false }],
				schedule: { state: 2, stability: 8, difficulty: 5.0, reps: 2, lapses: 0, last_review: now - 12 * DAY, due: now - 1 * DAY, dueDay: "2026-11-14" },
			},
			n_leaf: {
				id: "n_leaf",
				cues: [{ id: "q3", question: "Q3", answer: "A3", deleted: false }],
				schedule: { state: 2, stability: 30, difficulty: 3.5, reps: 5, lapses: 0, last_review: now - 1 * DAY, due: now + 20 * DAY, dueDay: "2026-12-05" },
			},
		},
		reviews: [] as unknown[],
	};

	const summary = computeGraphFsrsSummary(snapshot, flashcardsStore, now);
	assert.equal(summary.nodes.n_root?.dependentCount, 2); // n_mid + n_leaf
	assert.equal(summary.nodes.n_root?.isFoundation, true);
	assert.equal(summary.nodes.n_mid?.dependentCount, 1);
	assert.equal(summary.nodes.n_leaf?.dependentCount, 0);
	assert.equal(summary.nodes.n_leaf?.isFoundation, false);
	assert.equal(summary.nodes.n_untracked_found?.state, "untracked");
	assert.equal(summary.nodes.n_untracked_found?.dependentCount, 1);
	assert.equal(summary.counts.untrackedFoundations, 1);
	assert.equal(summary.counts.weakFoundations, 1);
	assert.ok(summary.examReadinessPct > 0 && summary.examReadinessPct < 100);

	// Test recordPracticeFsrsOutcome on disk (including 1-day recheck on single-miss strong prop & careless slip)
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-practice-fsrs-"));
	const file = path.join(dir, "flashcards.json");
	try {
		await fs.writeFile(file, JSON.stringify(flashcardsStore), "utf8");

		// 1) Careless slip when solved still gets rating 3 (Good), not Again
		const slipRes = recordPracticeFsrsOutcome({
			targets: ["n_mid"],
			outcome: "solved",
			rung: null,
			missClass: "careless",
			retest: false,
			flashcardsFile: file,
			now,
		});
		assert.deepEqual(slipRes.ratings, { n_mid: 3 });

		// 2) Surrendered once on strong card (S >= 10, lapses === 0) triggers 1-day re-check (Hard + 1d due)
		const recheckRes = recordPracticeFsrsOutcome({
			targets: ["n_root"],
			outcome: "surrendered",
			rung: "R4",
			missClass: "structural",
			retest: false,
			flashcardsFile: file,
			now,
		});
		assert.deepEqual(recheckRes.ratings, { n_root: 2 });
		assert.deepEqual(recheckRes.oneDayRecheckIds, ["n_root"]);

		const updated = JSON.parse(await fs.readFile(file, "utf8")) as typeof flashcardsStore;
		assert.equal(updated.propositions.n_root.schedule.due, now + DAY);
		assert.equal(updated.propositions.n_root.schedule.lapses, 0);
		assert.equal(updated.reviews.length, 2);

		// 3) practiceTools pose -> conclude invokes onConclude with target IDs
		const concluded: Array<{ outcome: string; targets: string[] }> = [];
		const tools = practiceTools({
			chatId: "chat-1",
			chatStore: { getChat: () => ({ messages: [], kind: "practice" }) },
			graphNodes: () => snapshot.nodes,
			onConclude: (input, targets) => concluded.push({ outcome: input.outcome, targets }),
		});

		await tools.problem!.execute("call-p1", {
			statement: "Prove Lemma B",
			target: ["n_mid"],
			kind: "proof",
			difficulty: 2,
			modelSolution: "Follows from Axiom A",
		} as never);
		await tools.conclude!.execute("call-c1", {
			outcome: "solved",
			verdict: "Correct proof",
			rung: null,
			missClass: null,
			retest: false,
		} as never);
		assert.deepEqual(concluded, [{ outcome: "solved", targets: ["n_mid"] }]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("Exam Prep config store, countdown calculation, and pace-aware prompt directives", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-exam-prep-"));
	const examFile = path.join(dir, "exam-prep.json");
	const now = new Date(2026, 10, 15, 10, 0, 0).getTime();

	try {
		assert.deepEqual(readExamPrepConfig(examFile), DEFAULT_EXAM_PREP_CONFIG);
		const emptyFsrs = computeGraphFsrsSummary({ nodes: [], chains: [] }, { propositions: {} }, now);

		const defaultStatus = computeExamPrepStatus(DEFAULT_EXAM_PREP_CONFIG, emptyFsrs, now);
		assert.equal(defaultStatus.promptDirective, null);

		writeExamPrepConfig(
			{ mode: "exam", examTitle: "Real Analysis Midterm", examDate: "2026-11-22", pace: "crash-course" },
			examFile,
		);
		const status = readExamPrepStatus({
			graphStore: {
				appendNode() {},
				readNodes: () => [{ id: "n1", name: "Bolzano-Weierstrass", statement: "Bounded seq has conv subseq", aliases: [], createdAt: "", provenance: [] }],
				appendChain() {},
				readChains: () => [],
				appendCheckpoint() {},
				readCheckpoints: () => [],
				appendCoverage() {},
				readCoverage: () => [],
				deleteNodes() { return 0; },
				deleteChains() { return 0; },
				deleteCheckpoints() { return 0; },
				deleteCoverage() { return 0; },
			} as never,
			examPrepFile: examFile,
			flashcardsFile: path.join(dir, "missing-flashcards.json"),
			now,
		});

		assert.equal(status.config.mode, "exam");
		assert.equal(status.daysRemaining, 7);
		assert.ok(status.promptDirective);
		assert.match(status.promptDirective!, /Dedicated Exam Prep/);
		assert.match(status.promptDirective!, /7 day\(s\) remaining/);
		assert.match(status.promptDirective!, /Crash Course/);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

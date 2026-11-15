import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	computeExamPrepStatus,
	computeGraphFsrsSummary,
	type GraphSnapshot,
} from "../src/core/index.ts";
import {
	BackupError,
	closePhoneUploadSession,
	createPhoneUploadSession,
	exportLearningBackup,
	getMobileCompanionState,
	importLearningBackup,
	rateMobileCompanionCard,
	readExamPrepStatus,
	stopPhoneUploadTunnel,
	updateMobileCompanionExamPrep,
	writeExamPrepConfig,
} from "../src/server/index.ts";
import { GET as getBackupRoute, POST as postBackupRoute } from "../app/api/backup/route.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix = "lh-wave2-"): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await closePhoneUploadSession();
	await stopPhoneUploadTunnel();
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

describe("Wave 2: FSRS-Aware Session Briefing & Foundation Names", () => {
	it("populates weakFoundationNames, duePropositionNames, untrackedFoundationNames and injects them into promptDirective", async () => {
		const DAY = 86_400_000;
		const now = Date.UTC(2026, 10, 15, 12, 0, 0);
		const ts = "2026-11-01T00:00:00.000Z";
		const snapshot: Pick<GraphSnapshot, "nodes" | "chains"> = {
			nodes: [
				{ id: "n_weak_root", name: "Completeness Axiom", statement: "Supremum property of R", aliases: [], createdAt: ts, provenance: [] },
				{ id: "n_untracked_root", name: "Archimedean Property", statement: "N is unbounded", aliases: [], createdAt: ts, provenance: [] },
				{ id: "n_leaf", name: "Bolzano-Weierstrass", statement: "Bounded seq has convergent subseq", aliases: [], createdAt: ts, provenance: [] },
			],
			chains: [
				{ id: "c1", premises: ["n_weak_root"], conclusion: "n_leaf", provenance: [], createdAt: ts },
				{ id: "c2", premises: ["n_untracked_root"], conclusion: "n_leaf", provenance: [], createdAt: ts },
			],
		};

		const flashcards = {
			version: 1,
			revision: 1,
			settings: { dayStart: 4, retention: 0.9 },
			decks: [{ id: "d1", name: "Analysis", propositionIds: ["n_weak_root", "n_leaf"] }],
			propositions: {
				n_weak_root: {
					id: "n_weak_root",
					name: "Completeness Axiom",
					cues: [{ id: "q_root", question: "State Completeness", answer: "Every nonempty bounded-above subset has a sup", deleted: false }],
					schedule: { state: 2, stability: 4, difficulty: 5, reps: 2, lapses: 1, last_review: now - 10 * DAY, due: now - 2 * DAY, dueDay: "2026-11-13" },
				},
				n_leaf: {
					id: "n_leaf",
					name: "Bolzano-Weierstrass",
					cues: [{ id: "q_leaf", question: "State BW", answer: "Bounded real seq has convergent subseq", deleted: false }],
					schedule: { state: 2, stability: 25, difficulty: 3.5, reps: 5, lapses: 0, last_review: now - 1 * DAY, due: now + 20 * DAY, dueDay: "2026-12-05" },
				},
			},
			reviews: [],
		};

		const summary = computeGraphFsrsSummary(snapshot, flashcards, now);
		const status = computeExamPrepStatus(
			{ mode: "exam", examTitle: "Analysis Midterm", examDate: "2026-11-20", pace: "efficient", updatedAt: ts },
			summary,
			now,
			snapshot.nodes,
		);

		assert.deepEqual(status.weakFoundationNames, ["Completeness Axiom"]);
		assert.deepEqual(status.duePropositionNames, ["Completeness Axiom"]);
		assert.deepEqual(status.untrackedFoundationNames, ["Archimedean Property"]);
		assert.ok(status.promptDirective);
		assert.match(status.promptDirective!, /Priority Weak Foundations.*Completeness Axiom/);
		assert.match(status.promptDirective!, /Untracked Foundations.*Archimedean Property/);

		// Verify readExamPrepStatus reads files & wires graph node names
		const dir = await makeTempDir("lh-brief-");
		const examFile = path.join(dir, "exam-prep.json");
		const fcFile = path.join(dir, "flashcards.json");
		await fs.writeFile(fcFile, JSON.stringify(flashcards), "utf8");
		writeExamPrepConfig({ mode: "exam", examTitle: "Midterm", pace: "crash-course" }, examFile);
		const fromDisk = readExamPrepStatus({
			graphStore: {
				appendNode() {},
				readNodes: () => snapshot.nodes,
				appendChain() {},
				readChains: () => snapshot.chains,
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
			flashcardsFile: fcFile,
			now,
		});
		assert.deepEqual(fromDisk.weakFoundationNames, ["Completeness Axiom"]);
		assert.deepEqual(fromDisk.untrackedFoundationNames, ["Archimedean Property"]);
	});
});

describe("Wave 2: KronoHarness Mobile Companion & FSRS-6 HTTP Endpoints", () => {
	it("loads due flashcards & recent sessions, grades cards on disk, switches exam prep mode, and serves companion routes", async () => {
		const DAY = 86_400_000;
		const now = Date.UTC(2026, 10, 15, 12, 0, 0);
		const dir = await makeTempDir("lh-companion-");
		const fcFile = path.join(dir, "flashcards.json");
		const examFile = path.join(dir, "exam-prep.json");
		const chatsDir = path.join(dir, "chats");
		await fs.mkdir(chatsDir, { recursive: true });

		const initialStore = {
			version: 1,
			revision: 1,
			settings: { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false },
			decks: [{ id: "deck_1", name: "Probability", propositionIds: ["prop_bayes", "prop_new"] }],
			propositions: {
				prop_bayes: {
					id: "prop_bayes",
					origin: "graph",
					name: "Bayes Theorem",
					statement: "P(A|B) = P(B|A)P(A)/P(B)",
					cues: [{ id: "cue_1", question: "Formula for P(A|B)?", answer: "P(B|A)P(A)/P(B)", deleted: false, latestRating: null }],
					schedule: { state: 2, stability: 5, difficulty: 4.5, reps: 2, lapses: 0, elapsed_days: 3, scheduled_days: 5, learning_steps: 0, last_review: now - 7 * DAY, due: now - 1 * DAY, dueDay: "2026-11-14" },
					firstReviewedAt: now - 10 * DAY,
					learningCueId: null,
					version: 1,
				},
				prop_new: {
					id: "prop_new",
					origin: "graph",
					name: "Law of Total Probability",
					statement: "P(B) = sum P(B|Ai)P(Ai)",
					cues: [{ id: "cue_2", question: "Expand P(B) over partition Ai", answer: "sum_i P(B|Ai)P(Ai)", deleted: false, latestRating: null }],
					schedule: { state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, last_review: null, due: now },
					firstReviewedAt: null,
					learningCueId: null,
					version: 1,
				},
			},
			reviews: [],
		};
		await fs.writeFile(fcFile, JSON.stringify(initialStore), "utf8");
		await fs.writeFile(
			path.join(chatsDir, "chat_recent.json"),
			JSON.stringify({
				id: "chat_recent",
				title: "Probability Review",
				kind: "practice",
				updatedAt: "2026-11-15T09:00:00.000Z",
				messages: [
					{ id: "m1", role: "user", content: [{ type: "text", text: "Quiz me" }], timestamp: now - 1000 },
					{ id: "m2", role: "assistant", content: [{ type: "text", text: "Derive Bayes rule from conditional probability." }], timestamp: now },
				],
			}),
			"utf8",
		);

		const state1 = getMobileCompanionState({ flashcardsFile: fcFile, examPrepFile: examFile, chatsDir, now });
		assert.equal(state1.totalDue, 1);
		assert.equal(state1.totalTracked, 2);
		assert.equal(state1.dueCards.length, 2);
		assert.equal(state1.dueCards[0]!.propositionId, "prop_bayes");
		assert.equal(state1.dueCards[0]!.isDue, true);
		assert.equal(state1.dueCards[1]!.propositionId, "prop_new");
		assert.equal(state1.dueCards[1]!.isDue, false);
		assert.equal(state1.recentSessions.length, 1);
		assert.equal(state1.recentSessions[0]!.mode, "practice");
		assert.match(state1.recentSessions[0]!.lastAssistantSnippet, /Derive Bayes rule/);

		// Direct rate check
		const rated = rateMobileCompanionCard({
			propositionId: "prop_bayes",
			cueId: "cue_1",
			rating: 3,
			flashcardsFile: fcFile,
			examPrepFile: examFile,
			chatsDir,
			now,
		});
		assert.equal(rated.ok, true);
		assert.ok(rated.nextDue > now);
		assert.equal(rated.state.totalDue, 0);

		const diskAfterRate = JSON.parse(await fs.readFile(fcFile, "utf8")) as {
			revision: number;
			reviews: Array<{ source: string; rating: number; propositionId: string }>;
		};
		assert.equal(diskAfterRate.revision, 2);
		assert.equal(diskAfterRate.reviews.length, 1);
		assert.equal(diskAfterRate.reviews[0]!.source, "mobile-companion");
		assert.equal(diskAfterRate.reviews[0]!.rating, 3);

		const epRes = updateMobileCompanionExamPrep(
			{ mode: "exam", examTitle: "Prob Stats", pace: "crash-course" },
			{ flashcardsFile: fcFile, examPrepFile: examFile, chatsDir, now },
		);
		assert.equal(epRes.examPrep.config.mode, "exam");
		assert.equal(epRes.examPrep.config.pace, "crash-course");

		// HTTP endpoints on createPhoneUploadSession
		const session = await createPhoneUploadSession({
			host: "127.0.0.1",
			attachmentsDir: dir,
			flashcardsFile: fcFile,
			examPrepFile: examFile,
			chatsDir,
		});
		const html = await (await fetch(`http://127.0.0.1:${session.port}/p/${session.token}`)).text();
		assert.ok(!html.includes("https://"), "companion HTML must remain offline-safe");
		assert.match(html, /id="tab-cards"/);
		assert.match(html, /id="tab-exam"/);

		const httpState = await (await fetch(`http://127.0.0.1:${session.port}/p/${session.token}/companion`)).json() as {
			dueCards: Array<{ propositionId: string }>;
			examPrep: { config: { mode: string } };
		};
		assert.equal(httpState.examPrep.config.mode, "exam");
		assert.equal(httpState.dueCards.length, 1); // prop_new remains unreviewed

		const rateHttpRes = await fetch(`http://127.0.0.1:${session.port}/p/${session.token}/companion/rate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ propositionId: "prop_new", cueId: "cue_2", rating: 4 }),
		});
		assert.equal(rateHttpRes.status, 200);
		const rateHttpJson = await rateHttpRes.json() as { ok: boolean; ratedPropositionId: string };
		assert.equal(rateHttpJson.ok, true);
		assert.equal(rateHttpJson.ratedPropositionId, "prop_new");

		const epHttpRes = await fetch(`http://127.0.0.1:${session.port}/p/${session.token}/companion/exam-prep`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "long-term", pace: "efficient" }),
		});
		assert.equal(epHttpRes.status, 200);
		const epHttpJson = await epHttpRes.json() as { examPrep: { config: { mode: string; pace: string } } };
		assert.equal(epHttpJson.examPrep.config.mode, "long-term");
		assert.equal(epHttpJson.examPrep.config.pace, "efficient");
	});
});

describe("Wave 2: 1-Click Snapshot Backup & Restore", () => {
	it("exports learning state without secrets, imports into a fresh directory, and blocks path traversal/auth.json", async () => {
		const srcDir = await makeTempDir("lh-backup-src-");
		const dstDir = await makeTempDir("lh-backup-dst-");

		await fs.mkdir(path.join(srcDir, "graph"), { recursive: true });
		await fs.mkdir(path.join(srcDir, "chats"), { recursive: true });
		await fs.mkdir(path.join(srcDir, "core-plugin-data", "flashcards", "sources"), { recursive: true });
		await fs.writeFile(path.join(srcDir, "auth.json"), JSON.stringify({ openai: "SECRET_KEY_DO_NOT_EXPORT" }), "utf8");
		await fs.writeFile(path.join(srcDir, "graph", "nodes.jsonl"), "{\"id\":\"n1\"}\n{\"id\":\"n2\"}\n", "utf8");
		await fs.writeFile(path.join(srcDir, "graph", "chains.jsonl"), "{\"id\":\"c1\"}\n", "utf8");
		await fs.writeFile(path.join(srcDir, "chats", "chat_1.json"), JSON.stringify({ id: "chat_1" }), "utf8");
		await fs.writeFile(
			path.join(srcDir, "core-plugin-data", "flashcards", "flashcards.json"),
			JSON.stringify({ propositions: { n1: {} }, reviews: [{ id: "r1" }, { id: "r2" }] }),
			"utf8",
		);
		await fs.writeFile(path.join(srcDir, "core-plugin-data", "flashcards", "sources", "s1.md"), "# Notes", "utf8");
		await fs.writeFile(path.join(srcDir, "exam-prep.json"), JSON.stringify({ mode: "exam" }), "utf8");
		await fs.writeFile(
			path.join(srcDir, "mistakes.json"),
			JSON.stringify([
				{
					id: "chat_1:tc1",
					chatId: "chat_1",
					sessionTitle: "Demo",
					sessionKind: "teaching",
					kind: "wrong",
					question: "2+2?",
					yourAnswer: "5",
					correctAnswer: "4",
					answeredAt: "2026-11-15T00:00:00.000Z",
					createdAt: "2026-11-15T00:00:00.000Z",
					status: "ready",
					analysis: {
						errorType: "calculation-slip",
						topic: "addition",
						whatYouDid: "picked 5",
						correct: "4",
						rule: "check small sums",
					},
				},
			]),
			"utf8",
		);

		const bundle = exportLearningBackup(srcDir);
		assert.equal(bundle.format, "kronoharness-backup-v1");
		assert.equal(bundle.summary.nodesCount, 2);
		assert.equal(bundle.summary.chainsCount, 1);
		assert.equal(bundle.summary.chatsCount, 1);
		assert.equal(bundle.summary.flashcardsPropositionsCount, 1);
		assert.equal(bundle.summary.flashcardsReviewsCount, 2);
		assert.equal(bundle.summary.mistakesCount, 1);
		assert.equal(Object.hasOwn(bundle.files, "auth.json"), false);
		assert.ok(!JSON.stringify(bundle).includes("SECRET_KEY_DO_NOT_EXPORT"));

		const restored = importLearningBackup(bundle, dstDir);
		assert.equal(restored.ok, true);
		assert.equal(restored.restoredFiles, 7);
		assert.equal(restored.summary.mistakesCount, 1);
		assert.match(await fs.readFile(path.join(dstDir, "mistakes.json"), "utf8"), /check small sums/);
		assert.equal(
			await fs.readFile(path.join(dstDir, "graph", "nodes.jsonl"), "utf8"),
			"{\"id\":\"n1\"}\n{\"id\":\"n2\"}\n",
		);
		assert.equal(
			await fs.readFile(path.join(dstDir, "core-plugin-data", "flashcards", "sources", "s1.md"), "utf8"),
			"# Notes",
		);

		assert.throws(
			() =>
				importLearningBackup(
					{
						format: "kronoharness-backup-v1",
						files: { "../escape.txt": "bad" },
					},
					dstDir,
				),
			(err: unknown) => err instanceof BackupError && err.status === 400,
		);
		assert.throws(
			() =>
				importLearningBackup(
					{
						format: "kronoharness-backup-v1",
						files: { "auth.json": "{}" },
					},
					dstDir,
				),
			(err: unknown) => err instanceof BackupError && err.status === 400,
		);

		// Route smoke test
		const getRes = await getBackupRoute();
		assert.equal(getRes.status, 200);
		assert.match(getRes.headers.get("content-disposition") ?? "", /kronoharness-backup-\d{4}-\d{2}-\d{2}\.json/);

		const badPost = await postBackupRoute(
			new Request("http://localhost/api/backup", { method: "POST", body: "not-json" }),
		);
		assert.equal(badPost.status, 400);
	});
});

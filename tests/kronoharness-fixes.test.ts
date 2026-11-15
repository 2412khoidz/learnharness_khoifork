import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import {
	BUNDLED_FSRS_SCHEDULER,
	createSchedule,
	preview as previewSchedule,
	rate as rateSchedule,
	type FsrsSchedule,
	type FsrsSettings,
} from "../src/core/fsrs-scheduler.ts";
import { computeExamPrepStatus, DEFAULT_EXAM_PREP_CONFIG } from "../src/core/exam-prep.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { readExamPrepConfig, readExamPrepStatus, writeExamPrepConfig } from "../src/server/exam-prep.ts";
import { loadFlashcardsScheduler } from "../src/server/graph-fsrs.ts";
import { buildMobileHtml, resolveMobileAsset } from "../src/server/phone-mobile-ui.ts";
import {
	getMobileCompanionSessionDetail,
	getMobileCompanionState,
} from "../src/server/phone-companion.ts";
import { closePhoneUploadSession, createPhoneUploadSession } from "../src/server/phone-upload.ts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

after(async () => {
	for (const dir of tempDirs) {
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

function createMemoryGraphStore(nodes: GraphNode[], chains: GraphChain[] = []): GraphStore {
	const currentNodes = nodes.map((n) => ({ ...n }));
	const currentChains = chains.map((c) => ({ ...c, premises: [...c.premises] }));
	return {
		readNodes: () => currentNodes.map((n) => ({ ...n })),
		readChains: () => currentChains.map((c) => ({ ...c, premises: [...c.premises] })),
		readSources: () => [],
		readCheckpoints: () => [],
		readCoverage: () => [],
		readPositions: () => ({}),
		appendNode: () => {},
		appendChain: () => {},
		appendCheckpoint: () => {},
		appendCoverage: () => {},
		upsertSource: () => {},
		deleteSources: () => 0,
		appendSourceUsage: () => {},
		writePositions: () => {},
		rewriteLedgers: () => {},
	};
}

describe("Bundled TypeScript FSRS-6 Scheduler", () => {
	it("matches plugins/flashcards/src/scheduler.cjs across states and ratings with fuzz=false", () => {
		const req = createRequire(import.meta.url);
		const legacy = req("../plugins/flashcards/src/scheduler.cjs") as {
			createSchedule: (now?: number) => FsrsSchedule;
			rate: (schedule: FsrsSchedule, rating: 1 | 2 | 3 | 4, now?: number, settings?: FsrsSettings) => FsrsSchedule;
			preview: (schedule: FsrsSchedule, now?: number, settings?: FsrsSettings) => Record<1 | 2 | 3 | 4, FsrsSchedule>;
			retrievability: (schedule: FsrsSchedule, now?: number) => number;
			isDue: (schedule: FsrsSchedule, now?: number, dayStart?: number) => boolean;
			studyDay: (now?: number, dayStart?: number) => string;
		};

		const settings = { fuzz: false, retention: 0.9, dayStart: 4 };
		const t0 = new Date("2026-11-01T10:00:00Z").getTime();
		const s0 = createSchedule(t0);
		assert.deepEqual(s0, legacy.createSchedule(t0));

		// Test transitions from New, Learning, Review, and Relearning states across ratings 1..4
		const states = [
			s0,
			rateSchedule(s0, 1, t0 + 60_000, settings),
			rateSchedule(s0, 3, t0 + 60_000, settings),
		];
		const tReview = t0 + 5 * 86_400_000;
		const reviewed = rateSchedule(states[2]!, 3, tReview, settings);
		states.push(reviewed, rateSchedule(reviewed, 1, tReview + 4 * 86_400_000, settings));

		for (const sched of states) {
			const now = (sched.last_review ?? t0) + 3 * 86_400_000;
			assert.equal(
				BUNDLED_FSRS_SCHEDULER.retrievability(sched, now),
				legacy.retrievability(sched, now),
			);
			assert.equal(BUNDLED_FSRS_SCHEDULER.isDue(sched, now, 4), legacy.isDue(sched, now, 4));
			assert.equal(BUNDLED_FSRS_SCHEDULER.studyDay(now, 4), legacy.studyDay(now, 4));
			assert.deepEqual(previewSchedule(sched, now, settings), legacy.preview(sched, now, settings));
			for (const r of [1, 2, 3, 4] as const) {
				assert.deepEqual(
					rateSchedule(sched, r, now, settings),
					legacy.rate(sched, r, now, settings),
				);
			}
		}

		// Server loader always returns working bundled FSRS scheduler without filesystem lookup
		const loaded = loadFlashcardsScheduler();
		assert.equal(loaded.studyDay(t0, 4), BUNDLED_FSRS_SCHEDULER.studyDay(t0, 4));
	});
});

describe("Subject-Scoped Exam Mode & Multi-Exam Profiles", () => {
	const DAY = 86_400_000;
	const now = new Date("2026-11-10T10:00:00Z").getTime();

	it("isolates Readiness %, weak roots, priority targets, and directives per subject cluster", async () => {
		const dir = await makeTempDir("kh-scoped-exam-");
		const examPrepFile = path.join(dir, "exam-prep.json");
		const flashcardsFile = path.join(dir, "flashcards.json");

		const nodes: GraphNode[] = [
			{
				id: "la_1",
				name: "Linear Independence",
				statement: "Vectors whose only trivial combination vanishes",
				aliases: [],
				createdAt: "2026-11-01T00:00:00Z",
				provenance: [{ chatId: "sess_la", messageId: "m1" }],
			},
			{
				id: "la_2",
				name: "Rank-Nullity Theorem",
				statement: "dim(ker T) + rank(T) = dim(V)",
				aliases: [],
				createdAt: "2026-11-01T00:00:00Z",
				provenance: [{ chatId: "sess_la", messageId: "m2" }],
			},
			{
				id: "ra_1",
				name: "Completeness Axiom",
				statement: "Every nonempty bounded-above subset of R has a supremum",
				aliases: [],
				createdAt: "2026-11-01T00:00:00Z",
				provenance: [{ chatId: "sess_ra", messageId: "m3" }],
			},
			{
				id: "ra_2",
				name: "Bolzano-Weierstrass",
				statement: "Bounded sequence in R has convergent subsequence",
				aliases: [],
				createdAt: "2026-11-01T00:00:00Z",
				provenance: [{ chatId: "sess_ra", messageId: "m4" }],
			},
		];
		const graphStore = createMemoryGraphStore(nodes, [
			{
				id: "c_la",
				premises: ["la_1"],
				conclusion: "la_2",
				provenance: [{ chatId: "sess_la", messageId: "m2" }],
				createdAt: "2026-11-01T00:00:00Z",
			},
			{
				id: "c_ra",
				premises: ["ra_1"],
				conclusion: "ra_2",
				provenance: [{ chatId: "sess_ra", messageId: "m4" }],
				createdAt: "2026-11-01T00:00:00Z",
			},
		]);

		// Linear Algebra has due/weak cards; Real Analysis is strongly mastered.
		await fs.writeFile(
			flashcardsFile,
			JSON.stringify({
				propositions: {
					la_1: {
						id: "la_1",
						name: "Linear Independence",
						cues: [{ id: "q1", question: "Define", answer: "c_i = 0", deleted: false }],
						schedule: { state: 2, stability: 1.5, difficulty: 7, reps: 2, lapses: 2, last_review: now - 5 * DAY, due: now - 2 * DAY, dueDay: "2026-11-08" },
					},
					la_2: {
						id: "la_2",
						name: "Rank-Nullity Theorem",
						cues: [{ id: "q2", question: "State", answer: "dim ker + rk = dim V", deleted: false }],
						schedule: { state: 2, stability: 2.0, difficulty: 6.5, reps: 1, lapses: 1, last_review: now - 4 * DAY, due: now - 1 * DAY, dueDay: "2026-11-09" },
					},
					ra_1: {
						id: "ra_1",
						name: "Completeness Axiom",
						cues: [{ id: "q3", question: "State", answer: "lub property", deleted: false }],
						schedule: { state: 2, stability: 60, difficulty: 2.5, reps: 8, lapses: 0, last_review: now - DAY, due: now + 40 * DAY, dueDay: "2026-12-20" },
					},
					ra_2: {
						id: "ra_2",
						name: "Bolzano-Weierstrass",
						cues: [{ id: "q4", question: "State", answer: "convergent subseq", deleted: false }],
						schedule: { state: 2, stability: 55, difficulty: 2.8, reps: 7, lapses: 0, last_review: now - DAY, due: now + 35 * DAY, dueDay: "2026-12-15" },
					},
				},
				reviews: [],
			}),
			"utf8",
		);

		const allStatus = readExamPrepStatus({ examPrepFile, flashcardsFile, graphStore, now });
		assert.equal(allStatus.availableScopes.length, 2);
		const laScope = allStatus.availableScopes.find((s) => s.dueCount === 2);
		const raScope = allStatus.availableScopes.find((s) => s.dueCount === 0);
		assert.ok(laScope && raScope);
		assert.ok(raScope.readinessPct > laScope.readinessPct);

		// Create & activate Linear Algebra exam profile
		writeExamPrepConfig(
			{
				mode: "exam",
				upsertExam: {
					id: "exam_la",
					title: "Linear Algebra Midterm",
					date: "2026-11-15",
					pace: "crash-course",
					clusterIds: [laScope.id],
				},
			},
			examPrepFile,
		);
		const laStatus = readExamPrepStatus({ examPrepFile, flashcardsFile, graphStore, now });
		assert.equal(laStatus.config.activeExamId, "exam_la");
		assert.deepEqual(laStatus.activeScopeLabels, [laScope.label]);
		assert.equal(laStatus.scopedNodeCount, 2);
		assert.equal(laStatus.totalNodeCount, 4);
		assert.equal(laStatus.examReadinessPct, laScope.readinessPct);
		assert.ok(laStatus.weakFoundationNames.includes("Linear Independence"));
		assert.ok(!laStatus.duePropositionNames.includes("Completeness Axiom"));
		assert.ok(laStatus.priorityPropositionIds.includes("la_1"));
		assert.ok(laStatus.promptDirective?.includes(`Focused Subject Scope: ${laScope.label}`));

		// Create & select Real Analysis exam profile -> Readiness jumps and LA items disappear
		writeExamPrepConfig(
			{
				mode: "exam",
				upsertExam: {
					id: "exam_ra",
					title: "Real Analysis Final",
					date: "2026-12-01",
					pace: "thorough",
					clusterIds: [raScope.id],
				},
			},
			examPrepFile,
		);
		const raStatus = readExamPrepStatus({ examPrepFile, flashcardsFile, graphStore, now });
		assert.equal(raStatus.config.activeExamId, "exam_ra");
		assert.equal(raStatus.config.examTitle, "Real Analysis Final");
		assert.equal(raStatus.examReadinessPct, raScope.readinessPct);
		assert.equal(raStatus.weakFoundationsCount, 0);
		assert.equal(raStatus.dueCount, 0);

		// Switching back to exam_la restores Linear Algebra config & cluster filter
		writeExamPrepConfig({ selectExamId: "exam_la" }, examPrepFile);
		const switchedBack = readExamPrepConfig(examPrepFile);
		assert.equal(switchedBack.activeExamId, "exam_la");
		assert.equal(switchedBack.examTitle, "Linear Algebra Midterm");
		assert.deepEqual(switchedBack.clusterIds, [laScope.id]);

		// Deleting active exam removes it cleanly; deleting the last remaining exam also clears legacy title/date
		writeExamPrepConfig({ deleteExamId: "exam_la" }, examPrepFile);
		const afterDelete = readExamPrepConfig(examPrepFile);
		assert.equal(afterDelete.exams.some((e) => e.id === "exam_la"), false);
		assert.notEqual(afterDelete.activeExamId, "exam_la");

		writeExamPrepConfig({ deleteExamId: afterDelete.activeExamId! }, examPrepFile);
		const afterLastDelete = readExamPrepConfig(examPrepFile);
		assert.equal(afterLastDelete.exams.length, 0);
		assert.equal(afterLastDelete.activeExamId, null);
		assert.equal(afterLastDelete.examTitle, "");
		assert.equal(afterLastDelete.examDate, null);

		// Legacy single-exam JSON (exams: [], non-empty examTitle) auto-migrates into a deletable profile
		await fs.writeFile(
			examPrepFile,
			JSON.stringify({
				mode: "exam",
				examTitle: "Vòng loại 1 OLP sinh viên",
				examDate: "2026-11-28",
				pace: "thorough",
				clusterIds: [],
				exams: [],
				activeExamId: null,
			}),
			"utf8",
		);
		const migrated = readExamPrepConfig(examPrepFile);
		assert.equal(migrated.exams.length, 1);
		assert.equal(migrated.activeExamId, migrated.exams[0]?.id);
		assert.equal(migrated.examTitle, "Vòng loại 1 OLP sinh viên");
		writeExamPrepConfig({ deleteExamId: migrated.activeExamId! }, examPrepFile);
		const afterMigratedDelete = readExamPrepConfig(examPrepFile);
		assert.equal(afterMigratedDelete.exams.length, 0);
		assert.equal(afterMigratedDelete.examTitle, "");
		assert.equal(afterMigratedDelete.examDate, null);
	});

	it("stays compatible with legacy ExamPrepConfigInput passed directly to computeExamPrepStatus", () => {
		const status = computeExamPrepStatus(DEFAULT_EXAM_PREP_CONFIG, {
			counts: { tracked: 0, strong: 0, decaying: 0, overdue: 0, prereqRisk: 0, untrackedFoundations: 0, weakFoundations: 0 },
			examReadinessPct: 100,
			nodes: {},
			hasCustomWeights: false,
			reviewCount: 0,
		});
		assert.equal(status.examReadinessPct, 100);
		assert.deepEqual(status.availableScopes, []);
	});
});

describe("Mobile Companion Redesigned UI, Assets & Dangling Questions", () => {
	it("produces syntactically valid JS, zero external URLs, bundled fonts/KaTeX & desktop theme CSS", () => {
		const html = buildMobileHtml("/p/tok123/upload");
		assert.equal(html.includes("https://"), false);
		assert.ok(html.includes("/p/tok123/assets/katex.min.css"));
		assert.ok(html.includes("/p/tok123/assets/katex.min.js"));
		assert.ok(html.includes("/p/tok123/assets/cmunbx.ttf"));
		assert.ok(html.includes("renderRichMath"));
		assert.ok(html.includes("fetchWithTimeout"));
		assert.ok(html.includes("new-session"));

		const scriptMatch = /<script>([\s\S]*?)<\/script>/g;
		let count = 0;
		for (const m of html.matchAll(scriptMatch)) {
			count++;
			assert.doesNotThrow(() => new vm.Script(m[1]!), "Inline mobile <script> must parse cleanly");
		}
		assert.equal(count, 1);
	});

	it("resolves bundled assets safely and blocks directory traversal", () => {
		assert.equal(resolveMobileAsset(["cmunbx.ttf"])?.contentType, "font/ttf");
		assert.equal(resolveMobileAsset(["katex.min.css"])?.contentType, "text/css; charset=utf-8");
		assert.equal(resolveMobileAsset(["katex.min.js"])?.contentType, "application/javascript; charset=utf-8");
		assert.equal(resolveMobileAsset(["fonts", "KaTeX_Main-Regular.woff2"])?.contentType, "font/woff2");
		assert.equal(resolveMobileAsset(["..", "package.json"]), null);
		assert.equal(resolveMobileAsset(["fonts", "..\\package.json"]), null);
		assert.equal(resolveMobileAsset(["fonts", "not-real.woff2"]), null);
	});

	it("filters archived chats, sorts pinned sessions first, and extracts pending question choices safely", async () => {
		const dir = await makeTempDir("kh-mob-sessions-");
		const chatsDir = path.join(dir, "chats");
		const examPrepFile = path.join(dir, "exam-prep.json");
		const flashcardsFile = path.join(dir, "flashcards.json");
		await fs.mkdir(chatsDir, { recursive: true });
		await fs.writeFile(flashcardsFile, JSON.stringify({ propositions: {}, reviews: [] }), "utf8");

		await fs.writeFile(
			path.join(chatsDir, "chat_archived.json"),
			JSON.stringify({
				id: "chat_archived",
				title: "Hidden Archived Chat",
				archived: true,
				updatedAt: "2026-11-15T12:00:00Z",
				messages: [{ role: "assistant", content: [{ type: "text", text: "Should not appear" }] }],
			}),
			"utf8",
		);
		await fs.writeFile(
			path.join(chatsDir, "chat_pinned.json"),
			JSON.stringify({
				id: "chat_pinned",
				title: "Pinned Linear Algebra",
				pinned: true,
				updatedAt: "2026-11-10T10:00:00Z",
				messages: [{ role: "assistant", content: [{ type: "text", text: "Eigenbasis review" }] }],
			}),
			"utf8",
		);
		await fs.writeFile(
			path.join(chatsDir, "chat_quiz.json"),
			JSON.stringify({
				id: "chat_quiz",
				title: "Quiz Turn",
				kind: "practice",
				updatedAt: "2026-11-14T10:00:00Z",
				messages: [
					{ role: "user", content: "Quiz me on matrices" },
					{
						id: "msg_quiz_1",
						role: "assistant",
						stopReason: "toolUse",
						content: [
							{
								type: "toolCall",
								id: "tc_quiz_1",
								name: "quiz",
								arguments: {
									question: "What is det(I_3)?",
									options: [
										{ label: "0", value: "0" },
										{ label: "1", value: "1" },
										{ label: "3", value: "3" },
									],
									correctAnswer: "1",
									explanation: "Product of diagonal entries",
								},
							},
						],
					},
				],
			}),
			"utf8",
		);

		const state = getMobileCompanionState({ flashcardsFile, examPrepFile, chatsDir });
		assert.deepEqual(
			state.recentSessions.map((s) => s.id),
			["chat_pinned", "chat_quiz"],
		);

		const detail = getMobileCompanionSessionDetail("chat_quiz", { chatsDir });
		assert.equal(detail.mode, "practice");
		assert.equal(detail.pendingQuestion?.toolCallId, "tc_quiz_1");
		assert.equal(detail.pendingQuestion?.kind, "quiz");
		assert.equal(detail.pendingQuestion?.options.length, 3);
		assert.equal("correctIndices" in (detail.pendingQuestion ?? {}), false);
		assert.equal("explanation" in (detail.pendingQuestion ?? {}), false);
	});

	it("serves local KaTeX/font assets and creates new sessions over HTTP", async () => {
		const dir = await makeTempDir("kh-mob-http-");
		const chatsDir = path.join(dir, "chats");
		const examPrepFile = path.join(dir, "exam-prep.json");
		const flashcardsFile = path.join(dir, "flashcards.json");
		await fs.mkdir(chatsDir, { recursive: true });
		await fs.writeFile(flashcardsFile, JSON.stringify({ propositions: {}, reviews: [] }), "utf8");

		const info = await createPhoneUploadSession({
			host: "127.0.0.1",
			attachmentsDir: path.join(dir, "att"),
			flashcardsFile,
			examPrepFile,
			chatsDir,
			enableTunnel: false,
		});
		const base = `http://127.0.0.1:${info.port}/p/${info.token}`;
		try {
			const [cssRes, fontRes, woffRes, badRes] = await Promise.all([
				fetch(`${base}/assets/katex.min.css`),
				fetch(`${base}/assets/cmunbx.ttf`),
				fetch(`${base}/assets/fonts/KaTeX_Main-Regular.woff2`),
				fetch(`${base}/assets/..%2Fpackage.json`),
			]);
			assert.equal(cssRes.status, 200);
			assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/);
			assert.equal(fontRes.status, 200);
			assert.equal(woffRes.status, 200);
			assert.equal(badRes.status, 404);

			const newSessRes = await fetch(`${base}/companion/new-session`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "teach", prompt: "Prove Cauchy-Schwarz inequality" }),
			});
			assert.equal(newSessRes.status, 200);
			const created = (await newSessRes.json()) as { ok: boolean; chatId: string; session: { title: string; mode: string } };
			assert.equal(created.ok, true);
			assert.ok(created.chatId.startsWith("chat_"));
			assert.equal(created.session.mode, "teach");

			const stateRes = await fetch(`${base}/companion`);
			assert.equal(stateRes.status, 200);
			const stateBody = (await stateRes.json()) as { recentSessions: Array<{ id: string }> };
			assert.ok(stateBody.recentSessions.some((s) => s.id === created.chatId));
		} finally {
			await closePhoneUploadSession(info.sessionId);
		}
	});
});

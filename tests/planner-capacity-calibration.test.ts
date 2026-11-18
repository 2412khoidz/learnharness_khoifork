import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { DailyStudyPlan } from "../src/core/planner.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-capacity-"));
process.env.LH_DATA_DIR = dir;
after(() => {
	const target = fs.realpathSync(dir);
	assert.ok(target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
	fs.rmSync(target, { recursive: true, force: true });
});

it("previews, applies and undoes workload content and realism independently without moving any block", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { collectRecallCandidates } = await import("../src/core/mistakes.ts");
	const { readPlannerConfig, savePlannerConfig } = await import("../src/server/planner.ts");
	const { recallGroupPreview } = await import("../src/server/recall-groups.ts");
	const { recallFingerprint } = await import("../src/server/recall-overrides.ts");
	const { applyCapacityCalibration, CapacityCalibrationConflict, previewCapacityCalibration, undoCapacityCalibration } =
		await import("../src/server/planner-capacity-calibration.ts");
	const subject = "Synthetic Math";
	const date = "2026-11-18";
	const nextDate = "2026-11-19";
	const now = new Date(2026, 10, 18, 12).getTime();
	const opts = { date, now };
	const chat = stores.chatStore.createChat(subject);
	const messages = Array.from({ length: 2 }, (_, i) => {
		const time = new Date(2026, 10, 16 + i, 10);
		return { role: "toolResult", toolName: "recall", toolCallId: `item${i}`, timestamp: time.getTime(),
			details: { kind: "explain", questionText: `Question ${i}`, text: "Answer", committed: "Answer", answeredAt: time.toISOString() }, content: [] };
	}) as unknown as LhMessage[];
	stores.chatStore.saveMessages(chat.id, messages);
	stores.graphStore.appendNode({
		id: "synthetic_node", name: "Limits", statement: "Bounds", aliases: [], createdAt: new Date(now).toISOString(),
		provenance: [{ chatId: chat.id, messageId: "m1" }],
	});
	const drafts = collectRecallCandidates(chat.id, messages).map((item) => item.draft);
	fs.writeFileSync(path.join(dir, "recall-scan.json"), JSON.stringify({
		version: 1, status: "complete", total: drafts.length,
		results: drafts.map((draft) => ({ id: draft.id, draft, sessionTitle: subject, verdict: "partial", topic: "Limits", missing: "Prove the bound" })),
	}));
	const candidates = recallGroupPreview(subject).items;
	assert.equal(candidates.length, 2);
	const saveGroup = (members: Array<{ id: string; fingerprint: string }>) => fs.writeFileSync(path.join(dir, "recall-groups.json"), JSON.stringify({
		version: 1, subjects: [{ subject, groups: [{
			id: "limits", name: "Limits", reason: "Bounds", model: "example",
			members: members.map(({ id, fingerprint }) => ({ id, fingerprint })),
		}] }],
	}));
	saveGroup(candidates);
	const nextPlan: DailyStudyPlan = {
		date: nextDate, generatedAt: new Date(now).toISOString(), engineUsed: "local", intensity: "healthy",
		minDailyStudyHours: 1, plannedStudyHours: 0.5, freeHoursTotal: 5,
		recommendedBedtime: "23:00", recommendedWakeTime: "07:00", todayWakeTime: "07:00",
		sleepShiftAdvice: "", daysToSleepTarget: 0, quotas: [],
		blocks: [{ date: nextDate, id: "study", startTime: "14:00", endTime: "14:30", startMin: 840, endMin: 870,
			durationMin: 30, title: "Existing work", type: "study", subject }],
	};
	savePlannerConfig({ ...readPlannerConfig(), plans: { [nextDate]: nextPlan }, realismFactor: 0.9 });
	const preview = previewCapacityCalibration(opts);
	assert.equal(preview.proposals.length, 1);
	const [proposal] = preview.proposals;
	assert.ok(proposal);
	assert.equal(proposal.date, nextDate);
	assert.deepEqual(proposal.focus, { topic: "Limits", minutes: 10, mode: "recheck" });
	assert.throws(() => applyCapacityCalibration({ revision: preview.revision, items: ["invalid"], realism: false }, opts), /Select valid/);
	assert.deepEqual(readPlannerConfig().plans[nextDate], nextPlan);

	fs.writeFileSync(path.join(dir, "recall-overrides.json"), JSON.stringify({ version: 1, entries: drafts.map((draft) => ({
		id: draft.id, fingerprint: recallFingerprint(draft), verdict: "partial", help: "independent", updatedAt: new Date(now - 1000).toISOString(),
	})) }));
	assert.throws(() => applyCapacityCalibration({ revision: preview.revision, items: [proposal.id], realism: false }, opts), CapacityCalibrationConflict);
	assert.equal(previewCapacityCalibration(opts).proposals.length, 0, "changed answers require reapproval of the topic");
	saveGroup(recallGroupPreview(subject).items);
	const refreshed = previewCapacityCalibration(opts);
	assert.deepEqual(refreshed.proposals[0]?.focus, { topic: "Limits", minutes: 10, mode: "practice", task: "Prove the bound" });

	const applied = applyCapacityCalibration({ revision: refreshed.revision, items: [proposal.id], realism: false }, opts);
	assert.equal(applied.applied, 1);
	const updated = readPlannerConfig();
	assert.equal(updated.realismFactor, 0.9);
	assert.deepEqual(updated.plans[nextDate], { ...nextPlan, blocks: [{ ...nextPlan.blocks[0], recallFocus: refreshed.proposals[0]!.focus }] });
	assert.throws(() => applyCapacityCalibration({ revision: refreshed.revision, items: [proposal.id], realism: false }, opts), CapacityCalibrationConflict);
	undoCapacityCalibration(applied.undoId, opts);
	assert.deepEqual(readPlannerConfig().plans[nextDate], nextPlan);

	const realismOnly = applyCapacityCalibration({ revision: previewCapacityCalibration(opts).revision, items: [], realism: true }, opts);
	assert.equal(realismOnly.applied, 0);
	assert.equal(realismOnly.realismApplied, true);
	assert.deepEqual(readPlannerConfig().plans[nextDate], nextPlan);
	assert.throws(() => undoCapacityCalibration(applied.undoId, opts), CapacityCalibrationConflict);
	undoCapacityCalibration(realismOnly.undoId, opts);
	assert.equal(readPlannerConfig().realismFactor, 0.9);
});

it("keeps the AI preview local, shows the exact model input and rejects a stale authorization", async () => {
	const { previewLearningCapacityDiagnosisServer, diagnoseLearningCapacityWithAiServer } = await import("../src/server/planner.ts");
	const fake = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	let calls = 0;
	const opts = {
		now: new Date(2026, 10, 18, 12).getTime(),
		engineOverride: { model: fake.getModel(), streamFn: (...args: Parameters<typeof fake.streamSimple>) => { calls++; return fake.streamSimple(...args); } },
	};
	const preview = previewLearningCapacityDiagnosisServer(opts);
	assert.equal(preview.revision, previewLearningCapacityDiagnosisServer(opts).revision);
	assert.equal(preview.modelLabel, "custom");
	assert.match(preview.systemPrompt, /advisory/);
	assert.equal(calls, 0);
	await assert.rejects(diagnoseLearningCapacityWithAiServer({ ...opts, previewRevision: "stale" }), /Preview the request again/);
	assert.equal(calls, 0);
});

it("evaluates optimized Flashcard FSRS on later reviews and leaves Recall and Practice reviews out of the experiment", async () => {
	const { evaluateFsrsForecast } = await import("../src/server/planner-capacity-experiments.ts");
	const now = Date.parse("2026-11-18T12:00:00Z");
	const reviews = Array.from({ length: 80 }, (_, i) => ({
		propositionId: `card${i % 4}`, rating: i % 7 === 0 ? 1 : 3, at: now - (80 - i) * 43_200_000,
	}));
	const result = evaluateFsrsForecast(reviews, now);
	assert.ok("test" in result);
	assert.equal(result.train, 60);
	assert.equal(result.test, 20);
	assert.ok(Number.isFinite(result.measured.brier) && Number.isFinite(result.reference.logLoss));
	assert.deepEqual(evaluateFsrsForecast([...reviews, { ...reviews[0], source: "recall" }, { ...reviews[0], source: "practice" }], now), result);
});

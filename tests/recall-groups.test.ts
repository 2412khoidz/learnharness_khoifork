import assert from "node:assert/strict";
import { it } from "node:test";
import { projectRecallGroups, validateRecallGroups, type RecallGroup, type RecallGroupSource } from "../src/core/recall-groups.ts";
import { isIncompleteProviderResponse, normalizeConceptSearch, retryIncompleteOnce } from "../src/core/recall-mapping.ts";
import { saveRecallGroupDraft, readRecallGroups, saveRecallGroups } from "../src/server/recall-groups-store.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sources: RecallGroupSource[] = [
	{ fingerprint: "v1", observation: { id: "1", chatId: "c", toolCallId: "1", subject: "Math", answeredAt: "2026-11-15T12:00:00Z", verdict: "partial", source: "ai", topic: "Limits" } },
	{ fingerprint: "v2", observation: { id: "2", chatId: "c", toolCallId: "2", subject: "Math", answeredAt: "2026-11-16T12:00:00Z", verdict: "wrong", source: "user", topic: "Convergence" } },
	{ fingerprint: "v3", observation: { id: "3", chatId: "c", toolCallId: "3", subject: "Math", answeredAt: "2026-07-01T12:00:00Z", verdict: "correct", source: "ai", topic: "Limits" } },
	{ fingerprint: "v4", observation: { id: "4", chatId: "c", toolCallId: "4", subject: "Math", answeredAt: "2026-11-16T12:00:00Z", verdict: "uncertain", source: "ai", topic: "Limits" } },
];
const group: RecallGroup = { id: "group", name: "Sequence limits", reason: "Related concepts", model: "synthetic", members: sources.map(({ observation, fingerprint }) => ({ id: observation.id, fingerprint })) };

it("retains earlier paid suggestions and existing approvals across new runs", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-group-history-"));
	try {
		saveRecallGroups("Math", [group], sources, dir);
		saveRecallGroupDraft("Math", [group], sources, dir);
		const newer = { ...group, id: "new", name: "New proposal", model: "second" };
		saveRecallGroupDraft("Math", [newer], sources, dir, "second");
		const data = readRecallGroups(dir)[0]!;
		assert.equal(data.groups[0]?.id, "group");
		assert.equal(data.draft?.[0]?.id, "new");
		assert.deepEqual(data.history?.map((run) => run.groups[0]?.id), ["group", "new"]);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("keeps verdicts and original links, respects the time window and detects changed sources", () => {
	const current = projectRecallGroups([group], sources, "last30", Date.parse("2026-11-17T12:00:00Z"))[0]!;
	assert.equal(current.stale, false); assert.equal(current.count, 3);
	assert.deepEqual(current.distribution, { correct: 0, partial: 1, wrong: 1, dont_know: 0, uncertain: 1 });
	assert.deepEqual(current.answers.map((item) => item.toolCallId), ["1", "2", "4"]);
	assert.equal(projectRecallGroups([group], sources, "allTime", Date.now())[0]!.count, 4);
	assert.equal(projectRecallGroups([group], [{ ...sources[0]!, fingerprint: "changed" }, ...sources.slice(1)], "allTime", Date.now())[0]!.stale, true);
	assert.equal(projectRecallGroups([group], sources.slice(1), "allTime", Date.now())[0]!.stale, true);
});

it("allows edits and splits only with unique, current answer identities", () => {
	const first = { ...group, name: "Edited", members: group.members.slice(0, 2) };
	const second = { ...group, id: "second", name: "Split", members: group.members.slice(2) };
	assert.equal(validateRecallGroups([first, second], sources), null);
	assert.match(validateRecallGroups([first, { ...second, members: [group.members[0]!, group.members[2]!] }], sources)!, /duplicated/);
	assert.match(validateRecallGroups([{ ...first, members: [{ ...first.members[0]!, fingerprint: "stale" }, first.members[1]!] }], sources)!, /changed/);
	assert.match(validateRecallGroups([{ ...first, members: first.members.slice(0, 1) }], sources)!, /at least two/);
	assert.match(validateRecallGroups([first], [{ ...sources[0]!, observation: { ...sources[0]!.observation, verdict: undefined, staleAssessment: true } }, ...sources.slice(1)])!, /current assessment/);
});

it("retries incomplete output once but never repeats quota, auth, network or cancelled calls", async () => {
	let calls = 0;
	assert.equal(await retryIncompleteOnce(async () => { if (++calls === 1) throw new Error("Incomplete JSON segment at the end"); return "ok"; }), "ok");
	assert.equal(calls, 2);
	for (const message of ["quota 429", "unauthorized 401", "network error"]) {
		calls = 0; await assert.rejects(retryIncompleteOnce(async () => { calls++; throw new Error(message); })); assert.equal(calls, 1);
	}
	const abort = new AbortController(); abort.abort(); calls = 0;
	await assert.rejects(retryIncompleteOnce(async () => { calls++; throw new Error("Incomplete JSON segment at the end"); }, abort.signal)); assert.equal(calls, 1);
	assert.equal(isIncompleteProviderResponse(new Error("quota 429")), false);
	assert.equal(normalizeConceptSearch("Định lý Hêinê"), "dinh ly heine");
});

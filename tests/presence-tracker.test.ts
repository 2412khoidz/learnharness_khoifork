import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPresenceTracker, formatHHMM, localDateKey, readPresenceDay } = require("../electron/presence-tracker.cjs") as {
	localDateKey: (ms: number) => string;
	formatHHMM: (ms: number) => string;
	readPresenceDay: (dataDir: string, date: string) => {
		date: string;
		firstActiveAt?: string;
		lastActiveAt?: string;
		awayIntervals: Array<{ startTime: string; endTime: string; reason: "sleep" | "lock" | "idle" }>;
	} | undefined;
	createPresenceTracker: (opts: {
		dataDir: string;
		powerMonitor: EventEmitter & { getSystemIdleTime?: () => number };
		nowFn?: () => number;
		idleThresholdSec?: number;
		pollIntervalMs?: number;
	}) => {
		filePath: string;
		poll: () => void;
		stop: () => void;
	};
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-presence-test-"));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

it("tracks first/last active clocks, sleep/lock/idle away windows >=15m, adjacent merge, and atomic persistence", () => {
	const dataDir = path.join(tmpDir, "run1");
	let clockMs = new Date(2026, 10, 23, 8, 5).getTime();
	let idleSec = 0;
	const pm = Object.assign(new EventEmitter(), {
		getSystemIdleTime: () => idleSec,
	});

	const tracker = createPresenceTracker({
		dataDir,
		powerMonitor: pm,
		nowFn: () => clockMs,
		idleThresholdSec: 900,
		pollIntervalMs: 0,
	});
	const date = localDateKey(clockMs);

	let summary = readPresenceDay(dataDir, date);
	assert.equal(summary?.firstActiveAt, "08:05");
	assert.equal(summary?.lastActiveAt, "08:05");
	assert.equal(summary?.awayIntervals.length, 0);

	// Short lock (<15m) should be ignored
	clockMs = new Date(2026, 10, 23, 9, 0).getTime();
	pm.emit("lock-screen");
	clockMs = new Date(2026, 10, 23, 9, 10).getTime();
	pm.emit("unlock-screen");
	summary = readPresenceDay(dataDir, date);
	assert.equal(summary?.awayIntervals.length, 0);
	assert.equal(summary?.lastActiveAt, "09:10");

	// Suspend >= 15m should be logged
	clockMs = new Date(2026, 10, 23, 12, 0).getTime();
	pm.emit("suspend");
	clockMs = new Date(2026, 10, 23, 12, 45).getTime();
	pm.emit("resume");

	// Immediately adjacent idle/lock within 2 minutes should merge with previous window
	clockMs = new Date(2026, 10, 23, 12, 46).getTime();
	pm.emit("lock-screen");
	clockMs = new Date(2026, 10, 23, 13, 10).getTime();
	pm.emit("unlock-screen");

	// Idle threshold exceeded later in the afternoon (backdated by idleSec)
	clockMs = new Date(2026, 10, 23, 15, 20).getTime();
	idleSec = 1200; // 20m idle -> started at 15:00
	tracker.poll();
	clockMs = new Date(2026, 10, 23, 15, 45).getTime();
	idleSec = 0;
	tracker.poll();

	clockMs = new Date(2026, 10, 23, 17, 50).getTime();
	tracker.stop();

	// Emitting after stop should do nothing
	clockMs = new Date(2026, 10, 23, 19, 0).getTime();
	pm.emit("suspend");
	clockMs = new Date(2026, 10, 23, 20, 0).getTime();
	pm.emit("resume");

	summary = readPresenceDay(dataDir, date);
	assert.equal(summary?.firstActiveAt, "08:05");
	assert.equal(summary?.lastActiveAt, formatHHMM(new Date(2026, 10, 23, 17, 50).getTime()));
	assert.deepEqual(summary?.awayIntervals, [
		{ startTime: "12:00", endTime: "13:10", reason: "sleep" },
		{ startTime: "15:00", endTime: "15:45", reason: "idle" },
	]);
});

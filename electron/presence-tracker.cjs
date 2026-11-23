"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MIN_AWAY_MS = 15 * 60_000;
const MAX_AWAY_MS = 720 * 60_000;
const MERGE_GAP_MIN = 2;
const MAX_DAYS_KEPT = 30;
const MAX_INTERVALS_PER_DAY = 24;
const VALID_REASONS = new Set(["sleep", "lock", "idle"]);

/** Format local date YYYY-MM-DD for a timestamp in ms. */
function localDateKey(ms) {
	const d = new Date(ms);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Format local HH:MM clock string for a timestamp in ms. */
function formatHHMM(ms) {
	const d = new Date(ms);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
}

function parseClockMinutes(hhmm) {
	if (typeof hhmm !== "string") return null;
	const match = hhmm.match(/^(\d{2}):(\d{2})$/);
	if (!match) return null;
	const h = Number(match[1]);
	const m = Number(match[2]);
	if (h < 0 || h > 23 || m < 0 || m > 59) return null;
	return h * 60 + m;
}

function minutesToHHMM(totalMin) {
	const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMin)));
	const h = String(Math.floor(clamped / 60)).padStart(2, "0");
	const m = String(clamped % 60).padStart(2, "0");
	return `${h}:${m}`;
}

function mergeAwayIntervals(intervals) {
	const parsed = [];
	for (const item of intervals) {
		if (!item || typeof item !== "object") continue;
		const s = parseClockMinutes(item.startTime);
		const e = parseClockMinutes(item.endTime);
		const reason = VALID_REASONS.has(item.reason) ? item.reason : "idle";
		if (s === null || e === null || e <= s) continue;
		parsed.push({ s, e, reason });
	}
	parsed.sort((a, b) => a.s - b.s || a.e - b.e);
	const merged = [];
	for (const cur of parsed) {
		const prev = merged[merged.length - 1];
		if (prev && cur.s <= prev.e + MERGE_GAP_MIN) {
			prev.e = Math.max(prev.e, cur.e);
		} else {
			merged.push({ ...cur });
		}
	}
	return merged.slice(0, MAX_INTERVALS_PER_DAY).map((it) => ({
		startTime: minutesToHHMM(it.s),
		endTime: minutesToHHMM(it.e),
		reason: it.reason,
	}));
}

function sanitizeDayRecord(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { awayIntervals: [] };
	}
	const out = {
		awayIntervals: Array.isArray(raw.awayIntervals) ? mergeAwayIntervals(raw.awayIntervals) : [],
	};
	if (parseClockMinutes(raw.firstActiveAt) !== null) out.firstActiveAt = raw.firstActiveAt;
	if (parseClockMinutes(raw.lastActiveAt) !== null) out.lastActiveAt = raw.lastActiveAt;
	return out;
}

function readStore(filePath) {
	try {
		if (!fs.existsSync(filePath)) return { version: 1, days: {} };
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.days || typeof parsed.days !== "object") {
			return { version: 1, days: {} };
		}
		const days = {};
		for (const [dateKey, val] of Object.entries(parsed.days)) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
			days[dateKey] = sanitizeDayRecord(val);
		}
		return { version: 1, days };
	} catch {
		return { version: 1, days: {} };
	}
}

function pruneDays(days) {
	const sortedKeys = Object.keys(days).sort((a, b) => b.localeCompare(a)).slice(0, MAX_DAYS_KEPT);
	const out = {};
	for (const k of sortedKeys) out[k] = days[k];
	return out;
}

function writeStoreAtomic(filePath, store) {
	const payload = JSON.stringify({ version: 1, days: pruneDays(store.days) }, null, 2);
	const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(tmp, payload, "utf8");
		fs.renameSync(tmp, filePath);
	} catch {
		try {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		} catch {
			// Best-effort cleanup only.
		}
	}
}

/** Read a single day's sanitized presence summary, or undefined if absent. */
function readPresenceDay(dataDir, date) {
	if (!dataDir || !/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return undefined;
	const filePath = path.join(dataDir, "presence-log.json");
	const store = readStore(filePath);
	const rec = store.days[date];
	if (!rec) return undefined;
	if (!rec.firstActiveAt && !rec.lastActiveAt && rec.awayIntervals.length === 0) return undefined;
	return {
		date,
		...(rec.firstActiveAt ? { firstActiveAt: rec.firstActiveAt } : {}),
		...(rec.lastActiveAt ? { lastActiveAt: rec.lastActiveAt } : {}),
		awayIntervals: rec.awayIntervals,
	};
}

/**
 * Track desktop presence locally via Electron powerMonitor events + idle polling.
 * Writes strictly local summaries to <dataDir>/presence-log.json.
 */
function createPresenceTracker({
	dataDir,
	powerMonitor,
	nowFn = Date.now,
	idleThresholdSec = 900,
	pollIntervalMs = 60_000,
}) {
	const filePath = path.join(dataDir, "presence-log.json");
	let store = readStore(filePath);
	let awayStartMs = null;
	let awayReason = null;
	let stopped = false;

	function ensureDay(dateKey) {
		if (!store.days[dateKey]) {
			store.days[dateKey] = { awayIntervals: [] };
		}
		return store.days[dateKey];
	}

	function touchActive(ms) {
		const dateKey = localDateKey(ms);
		const hhmm = formatHHMM(ms);
		const day = ensureDay(dateKey);
		let changed = false;
		if (!day.firstActiveAt || hhmm < day.firstActiveAt) {
			day.firstActiveAt = hhmm;
			changed = true;
		}
		if (!day.lastActiveAt || hhmm > day.lastActiveAt) {
			day.lastActiveAt = hhmm;
			changed = true;
		}
		return changed;
	}

	function closeAway(endMs) {
		let changed = false;
		if (awayStartMs !== null) {
			const startMs = awayStartMs;
			const reason = awayReason ?? "idle";
			awayStartMs = null;
			awayReason = null;

			const durationMs = endMs - startMs;
			const startDate = localDateKey(startMs);
			const endDate = localDateKey(endMs);
			if (startDate === endDate && durationMs >= MIN_AWAY_MS && durationMs <= MAX_AWAY_MS) {
				const startTime = formatHHMM(startMs);
				const endTime = formatHHMM(endMs);
				if (startTime !== endTime) {
					const day = ensureDay(endDate);
					const nextIntervals = mergeAwayIntervals([
						...day.awayIntervals,
						{ startTime, endTime, reason },
					]);
					if (JSON.stringify(nextIntervals) !== JSON.stringify(day.awayIntervals)) {
						day.awayIntervals = nextIntervals;
						changed = true;
					}
				}
			}
		}
		if (touchActive(endMs)) changed = true;
		if (changed) writeStoreAtomic(filePath, store);
	}

	function openAway(startMs, reason) {
		if (awayStartMs !== null) return;
		awayStartMs = startMs;
		awayReason = reason;
	}

	function poll() {
		if (stopped || !powerMonitor || typeof powerMonitor.getSystemIdleTime !== "function") return;
		let idleSec = 0;
		try {
			idleSec = Number(powerMonitor.getSystemIdleTime()) || 0;
		} catch {
			return;
		}
		const nowMs = nowFn();
		if (awayStartMs === null) {
			if (idleSec >= idleThresholdSec) {
				openAway(nowMs - idleSec * 1000, "idle");
			} else if (touchActive(nowMs)) {
				writeStoreAtomic(filePath, store);
			}
		} else if (awayReason === "idle" && idleSec < 60) {
			closeAway(nowMs);
		}
	}

	const onSuspend = () => {
		if (!stopped) openAway(nowFn(), "sleep");
	};
	const onLock = () => {
		if (!stopped) openAway(nowFn(), "lock");
	};
	const onResume = () => {
		if (!stopped) closeAway(nowFn());
	};
	const onUnlock = () => {
		if (!stopped) closeAway(nowFn());
	};

	if (touchActive(nowFn())) {
		writeStoreAtomic(filePath, store);
	}

	if (powerMonitor && typeof powerMonitor.on === "function") {
		powerMonitor.on("suspend", onSuspend);
		powerMonitor.on("lock-screen", onLock);
		powerMonitor.on("resume", onResume);
		powerMonitor.on("unlock-screen", onUnlock);
	}

	const timer = pollIntervalMs > 0 ? setInterval(poll, pollIntervalMs) : null;
	if (timer && typeof timer.unref === "function") timer.unref();

	function detach(ev, fn) {
		if (!powerMonitor) return;
		if (typeof powerMonitor.off === "function") powerMonitor.off(ev, fn);
		else if (typeof powerMonitor.removeListener === "function") powerMonitor.removeListener(ev, fn);
	}

	function stop() {
		if (stopped) return;
		stopped = true;
		if (timer) clearInterval(timer);
		detach("suspend", onSuspend);
		detach("lock-screen", onLock);
		detach("resume", onResume);
		detach("unlock-screen", onUnlock);
		if (awayStartMs !== null) {
			closeAway(nowFn());
		} else if (touchActive(nowFn())) {
			writeStoreAtomic(filePath, store);
		} else {
			writeStoreAtomic(filePath, store);
		}
	}

	return {
		filePath,
		poll,
		stop,
		getState: () => ({ awayStartMs, awayReason }),
	};
}

module.exports = {
	localDateKey,
	formatHHMM,
	createPresenceTracker,
	readPresenceDay,
};

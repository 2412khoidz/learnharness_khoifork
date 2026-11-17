import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_PLANNER_CONFIG, sanitizePlannerConfig } from "../src/core/planner.ts";

it("retains separate hobby budgets and preferred times without altering old defaults", () => {
	const config = sanitizePlannerConfig({ ...DEFAULT_PLANNER_CONFIG, lifestyle: { ...DEFAULT_PLANNER_CONFIG.lifestyle, hobbies: ["Reading", "Sport"], hobbyPreferences: { Reading: { dailyMin: 30, preferredWindow: "evening" }, Sport: { dailyMin: 45, preferredWindow: "morning" } } } });
	assert.deepEqual(config.lifestyle.hobbyPreferences?.Reading, { dailyMin: 30, preferredWindow: "evening" });
	assert.deepEqual(config.lifestyle.hobbyPreferences?.Sport, { dailyMin: 45, preferredWindow: "morning" });
	assert.equal(sanitizePlannerConfig(DEFAULT_PLANNER_CONFIG).lifestyle.hobbyPreferences, undefined);
});

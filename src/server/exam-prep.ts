import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	computeExamPrepStatus,
	DEFAULT_EXAM_PREP_CONFIG,
	sanitizeExamPrepConfig,
	type ExamPrepConfig,
	type ExamPrepStatus,
} from "../core/exam-prep.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";
import { readGraphFsrsSummary } from "./graph-fsrs.ts";
import { stores } from "./stores.ts";

export function defaultExamPrepPath(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "exam-prep.json");
}

export function readExamPrepConfig(filePath = defaultExamPrepPath()): ExamPrepConfig {
	try {
		if (!fs.existsSync(filePath)) return { ...DEFAULT_EXAM_PREP_CONFIG };
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
		return sanitizeExamPrepConfig(parsed, DEFAULT_EXAM_PREP_CONFIG);
	} catch {
		return { ...DEFAULT_EXAM_PREP_CONFIG };
	}
}

export function writeExamPrepConfig(
	patch: Partial<ExamPrepConfig>,
	filePath = defaultExamPrepPath(),
): ExamPrepConfig {
	const current = readExamPrepConfig(filePath);
	const next = sanitizeExamPrepConfig(
		{
			...current,
			...patch,
			updatedAt: new Date().toISOString(),
		},
		current,
	);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
	return next;
}

export function readExamPrepStatus(opts?: {
	graphStore?: GraphStore;
	examPrepFile?: string;
	flashcardsFile?: string;
	now?: number;
}): ExamPrepStatus {
	const config = readExamPrepConfig(opts?.examPrepFile);
	const graphStore = opts?.graphStore ?? stores.graphStore;
	const snapshot: Pick<GraphSnapshot, "nodes" | "chains"> = graphStore
		? { nodes: graphStore.readNodes(), chains: graphStore.readChains() }
		: { nodes: [], chains: [] };
	const fsrs = readGraphFsrsSummary(snapshot, opts?.flashcardsFile, opts?.now);
	return computeExamPrepStatus(config, fsrs, opts?.now, snapshot.nodes);
}

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	applyExamPrepPatch,
	computeExamPrepStatus,
	DEFAULT_EXAM_PREP_CONFIG,
	sanitizeExamPrepConfig,
	type ExamPrepConfig,
	type ExamPrepMistakeHints,
	type ExamPrepPatch,
	type ExamPrepStatus,
	type ExamScopeOption,
} from "../core/exam-prep.ts";
import { ERROR_TYPE_LABELS, summarizeMistakes, type MistakeRecord } from "../core/mistakes.ts";
import { computeGraphFsrsSummary, emptyGraphFsrsSummary } from "../core/fsrs-graph.ts";
import type { Cluster, GraphChain, GraphNode } from "../core/contracts.ts";
import type { GraphStore } from "../core/ports.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import { graphView } from "./graph.ts";
import { readFlashcardsSnapshot } from "./graph-fsrs.ts";
import { readMistakes } from "../store/mistakes.ts";

export function defaultExamPrepPath(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "exam-prep.json");
}

export function readExamPrepConfig(filePath = defaultExamPrepPath()): ExamPrepConfig {
	try {
		if (!fs.existsSync(/* turbopackIgnore: true */ filePath)) {
			return sanitizeExamPrepConfig(DEFAULT_EXAM_PREP_CONFIG);
		}
		const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8")) as unknown;
		return sanitizeExamPrepConfig(parsed, DEFAULT_EXAM_PREP_CONFIG);
	} catch {
		return sanitizeExamPrepConfig(DEFAULT_EXAM_PREP_CONFIG);
	}
}

export function writeExamPrepConfig(
	patch: ExamPrepPatch,
	filePath = defaultExamPrepPath(),
): ExamPrepConfig {
	const current = readExamPrepConfig(filePath);
	const next = applyExamPrepPatch(current, patch, new Date().toISOString());
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
	return next;
}

interface ResolvedCluster {
	id: string;
	label: string;
	memberIds: Set<string>;
}

function resolveScopeClusters(
	propositions: readonly GraphNode[],
	explicitClusters?: readonly Cluster[],
	sessions?: Record<string, string>,
): ResolvedCluster[] {
	const propIds = new Set(propositions.map((n) => n.id));
	const byId = new Map<string, ResolvedCluster>();

	if (explicitClusters) {
		for (const c of explicitClusters) {
			const members = new Set(c.members.filter((id) => propIds.has(id)));
			if (members.size === 0) continue;
			byId.set(c.id, { id: c.id, label: c.label || c.id, memberIds: members });
		}
	}

	const birth = birthSessionPartition(propositions);
	for (const cluster of birth) {
		if (byId.has(cluster.id)) continue;
		const label = sessions?.[cluster.id]?.trim();
		if (!label && explicitClusters) continue;
		const members = new Set(cluster.members.filter((id) => propIds.has(id)));
		if (members.size === 0) continue;
		byId.set(cluster.id, {
			id: cluster.id,
			label: label || cluster.id,
			memberIds: members,
		});
	}

	return [...byId.values()].sort((a, b) => b.memberIds.size - a.memberIds.size);
}

function buildExamPrepMistakeHints(records: readonly MistakeRecord[]): ExamPrepMistakeHints | undefined {
	if (records.length === 0) return undefined;
	const summary = summarizeMistakes(records);
	const top = summary.byType[0];
	const recurringPattern = top ? `${ERROR_TYPE_LABELS[top.type]} (${top.count})` : null;
	const sortedReady = [...records]
		.filter((r) => r.status === "ready" && typeof r.analysis?.rule === "string" && r.analysis.rule.trim())
		.sort((a, b) => (b.createdAt || b.answeredAt || "").localeCompare(a.createdAt || a.answeredAt || ""));
	const recentRules: string[] = [];
	const seen = new Set<string>();
	for (const rec of sortedReady) {
		const rule = rec.analysis!.rule.replace(/\s+/g, " ").trim().slice(0, 120);
		if (!rule || seen.has(rule)) continue;
		seen.add(rule);
		recentRules.push(rule);
		if (recentRules.length >= 3) break;
	}
	return {
		totalCount: summary.total,
		recurringPattern,
		recentRules,
	};
}

export function readExamPrepStatus(opts?: {
	graphStore?: GraphStore;
	clusters?: Cluster[];
	sessions?: Record<string, string>;
	examPrepFile?: string;
	flashcardsFile?: string;
	mistakesFile?: string;
	mistakes?: readonly MistakeRecord[];
	now?: number;
}): ExamPrepStatus {
	const now = opts?.now ?? Date.now();
	const config = readExamPrepConfig(opts?.examPrepFile);
	const flashcards = readFlashcardsSnapshot(opts?.flashcardsFile);

	let propositions: GraphNode[];
	let chains: GraphChain[];
	let scopeDefs: ResolvedCluster[];

	if (opts?.graphStore) {
		propositions = opts.graphStore.readNodes();
		chains = opts.graphStore.readChains();
		scopeDefs = resolveScopeClusters(propositions, opts.clusters, opts.sessions);
	} else {
		const graph = graphView();
		propositions = graph.propositions;
		chains = graph.chains;
		scopeDefs = resolveScopeClusters(propositions, opts?.clusters ?? graph.clusters, opts?.sessions ?? graph.sessions);
	}

	const propsById = new Map(propositions.map((n) => [n.id, n]));
	const availableScopes: ExamScopeOption[] = [];
	const scopeMap = new Map<string, ResolvedCluster>();
	for (const def of scopeDefs) {
		scopeMap.set(def.id, def);
		const memberNodes: GraphNode[] = [];
		for (const id of def.memberIds) {
			const node = propsById.get(id);
			if (node) memberNodes.push(node);
		}
		if (memberNodes.length === 0) continue;
		const memberChains = chains.filter((c) => def.memberIds.has(c.conclusion));
		const subFsrs = flashcards
			? computeGraphFsrsSummary({ nodes: memberNodes, chains: memberChains }, flashcards, now)
			: emptyGraphFsrsSummary();
		availableScopes.push({
			id: def.id,
			label: def.label,
			nodeCount: memberNodes.length,
			trackedCount: subFsrs.counts.tracked,
			dueCount: (subFsrs.counts.overdue ?? 0) + (subFsrs.counts.decaying ?? 0),
			readinessPct: subFsrs.examReadinessPct,
		});
	}

	const matchedScopes = (config.clusterIds ?? [])
		.map((id) => scopeMap.get(id))
		.filter((c): c is ResolvedCluster => Boolean(c));

	let activeNodes = propositions;
	let activeChains = chains;
	const activeScopeLabels: string[] = [];

	if (matchedScopes.length > 0) {
		const scopedIds = new Set<string>();
		for (const sc of matchedScopes) {
			activeScopeLabels.push(sc.label);
			for (const id of sc.memberIds) scopedIds.add(id);
		}
		activeNodes = propositions.filter((n) => scopedIds.has(n.id));
		activeChains = chains.filter((c) => scopedIds.has(c.conclusion));
	}

	const fsrs = flashcards
		? computeGraphFsrsSummary({ nodes: activeNodes, chains: activeChains }, flashcards, now)
		: emptyGraphFsrsSummary();

	const mistakeRecords = opts?.mistakes ?? (
		opts?.mistakesFile
			? readMistakes(opts.mistakesFile)
			: opts?.examPrepFile
				? []
				: readMistakes()
	);
	const mistakeHints = buildExamPrepMistakeHints(mistakeRecords);

	return computeExamPrepStatus(config, fsrs, now, activeNodes, {
		availableScopes,
		activeScopeLabels,
		scopedNodeCount: activeNodes.length,
		totalNodeCount: propositions.length,
		mistakeHints,
	});
}

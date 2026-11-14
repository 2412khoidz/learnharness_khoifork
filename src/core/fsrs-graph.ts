import type { GraphSnapshot } from "./contracts.ts";

const DEFAULT_FSRS6_W = [
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
	0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
	1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
] as const;

const DAY_MS = 86_400_000;

export type FsrsNodeStateLabel = "untracked" | "new" | "learning" | "review" | "relearning";
export type FsrsMemoryBand = "untracked" | "new" | "strong" | "decaying" | "overdue";

export interface WeakPrerequisiteInfo {
	id: string;
	name: string;
	retrievability: number;
	due: boolean;
}

export interface NodeFsrsInfo {
	id: string;
	state: FsrsNodeStateLabel;
	memoryBand: FsrsMemoryBand;
	retrievability: number | null;
	stability: number;
	difficulty: number;
	due: boolean;
	reps: number;
	lapses: number;
	weakPrerequisites: WeakPrerequisiteInfo[];
	dependentCount: number;
	isFoundation: boolean;
}

export interface GraphFsrsSummary {
	nodes: Record<string, NodeFsrsInfo>;
	counts: {
		tracked: number;
		strong: number;
		decaying: number;
		overdue: number;
		prereqRisk: number;
		untrackedFoundations: number;
		weakFoundations: number;
	};
	hasCustomWeights: boolean;
	reviewCount: number;
	examReadinessPct: number;
}

export interface FlashcardsScheduleSnapshot {
	due?: number;
	dueDay?: string;
	stability?: number;
	difficulty?: number;
	reps?: number;
	lapses?: number;
	state?: number;
	last_review?: number | null;
}

export interface FlashcardsStoreSnapshot {
	settings?: {
		dayStart?: number;
		weights?: number[];
	};
	propositions?: Record<string, {
		id?: string;
		cues?: Array<{ deleted?: boolean }>;
		schedule?: FlashcardsScheduleSnapshot;
	}>;
	reviews?: unknown[];
}

function studyDayFor(now: number, startHour: number): string {
	const date = new Date(now);
	date.setHours(startHour, 0, 0, 0);
	if (+date > now) {
		date.setDate(date.getDate() - 1);
		date.setHours(startHour, 0, 0, 0);
	}
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isScheduleDue(schedule: FlashcardsScheduleSnapshot, now: number, dayStart: number): boolean {
	if (schedule.state === 2 && typeof schedule.dueDay === "string" && schedule.dueDay) {
		return studyDayFor(now, dayStart) >= schedule.dueDay;
	}
	return typeof schedule.due === "number" && Number.isFinite(schedule.due) && schedule.due <= now;
}

function computeRetrievability(
	schedule: FlashcardsScheduleSnapshot,
	now: number,
	w20: number,
): number | null {
	if (
		!schedule ||
		schedule.state === 0 ||
		schedule.last_review == null ||
		typeof schedule.last_review !== "number" ||
		typeof schedule.stability !== "number" ||
		schedule.stability <= 0
	) {
		return null;
	}
	const decay = -w20;
	const factor = Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1;
	const elapsedDays = Math.max(0, (now - schedule.last_review) / DAY_MS);
	const raw = Math.pow(1 + (factor * elapsedDays) / schedule.stability, decay);
	return Math.min(1, Math.max(0, Number(raw.toFixed(4))));
}

function stateLabel(state: number | undefined): FsrsNodeStateLabel {
	switch (state) {
		case 0: return "new";
		case 1: return "learning";
		case 2: return "review";
		case 3: return "relearning";
		default: return "untracked";
	}
}

export function emptyGraphFsrsSummary(): GraphFsrsSummary {
	return {
		nodes: {},
		counts: {
			tracked: 0,
			strong: 0,
			decaying: 0,
			overdue: 0,
			prereqRisk: 0,
			untrackedFoundations: 0,
			weakFoundations: 0,
		},
		hasCustomWeights: false,
		reviewCount: 0,
		examReadinessPct: 0,
	};
}

/**
 * Pure derivation joining Knowledge Graph propositions and reasoning chains
 * with Flashcards FSRS-6 scheduling state, including upstream prerequisite
 * decay alerts (`A -> B` where A's retrievability < 0.80 or A is overdue)
 * and downstream foundation dependency counts.
 */
export function computeGraphFsrsSummary(
	snapshot: Pick<GraphSnapshot, "nodes" | "chains">,
	flashcards: FlashcardsStoreSnapshot | null | undefined,
	now = Date.now(),
): GraphFsrsSummary {
	if (!flashcards || typeof flashcards !== "object" || !flashcards.propositions) {
		return emptyGraphFsrsSummary();
	}

	const rawWeights = flashcards.settings?.weights;
	const hasCustomWeights = Array.isArray(rawWeights) && rawWeights.length === 21 && rawWeights.every((n) => typeof n === "number" && Number.isFinite(n));
	const w20 = hasCustomWeights ? rawWeights[20]! : DEFAULT_FSRS6_W[20];
	const dayStart = Number.isInteger(flashcards.settings?.dayStart) && flashcards.settings!.dayStart! >= 0 && flashcards.settings!.dayStart! <= 23
		? flashcards.settings!.dayStart!
		: 4;

	const nodesById = new Map(snapshot.nodes.map((n) => [n.id, n]));
	const dependentsOf = new Map<string, Set<string>>();
	for (const chain of snapshot.chains ?? []) {
		if (!nodesById.has(chain.conclusion)) continue;
		for (const premiseId of chain.premises) {
			if (!nodesById.has(premiseId) || premiseId === chain.conclusion) continue;
			let targets = dependentsOf.get(premiseId);
			if (!targets) {
				targets = new Set();
				dependentsOf.set(premiseId, targets);
			}
			targets.add(chain.conclusion);
		}
	}

	const dependentCountById = new Map<string, number>();
	for (const node of snapshot.nodes) {
		const visited = new Set<string>();
		const queue: string[] = [...(dependentsOf.get(node.id) ?? [])];
		while (queue.length > 0) {
			const nextId = queue.shift()!;
			if (nextId === node.id || visited.has(nextId)) continue;
			visited.add(nextId);
			for (const childId of dependentsOf.get(nextId) ?? []) {
				if (!visited.has(childId) && childId !== node.id) queue.push(childId);
			}
		}
		dependentCountById.set(node.id, visited.size);
	}

	const nodes: Record<string, NodeFsrsInfo> = {};
	let tracked = 0;
	let strong = 0;
	let decaying = 0;
	let overdue = 0;

	for (const node of snapshot.nodes) {
		const dependentCount = dependentCountById.get(node.id) ?? 0;
		const isFoundation = dependentCount >= 1;
		const prop = flashcards.propositions[node.id];
		const hasActiveCues = Array.isArray(prop?.cues) && prop.cues.some((c) => !c.deleted);
		if (!prop || !hasActiveCues || !prop.schedule) {
			if (isFoundation) {
				nodes[node.id] = {
					id: node.id,
					state: "untracked",
					memoryBand: "untracked",
					retrievability: null,
					stability: 0,
					difficulty: 0,
					due: false,
					reps: 0,
					lapses: 0,
					weakPrerequisites: [],
					dependentCount,
					isFoundation,
				};
			}
			continue;
		}

		tracked++;
		const s = prop.schedule;
		const st = stateLabel(s.state);
		const due = s.state !== 0 && isScheduleDue(s, now, dayStart);
		const r = computeRetrievability(s, now, w20);

		let memoryBand: FsrsMemoryBand;
		if (st === "new" || r === null) {
			memoryBand = "new";
		} else if (due || st === "relearning" || r < 0.75) {
			memoryBand = "overdue";
			overdue++;
		} else if (r < 0.90) {
			memoryBand = "decaying";
			decaying++;
		} else {
			memoryBand = "strong";
			strong++;
		}

		nodes[node.id] = {
			id: node.id,
			state: st,
			memoryBand,
			retrievability: r,
			stability: typeof s.stability === "number" ? Number(s.stability.toFixed(2)) : 0,
			difficulty: typeof s.difficulty === "number" ? Number(s.difficulty.toFixed(2)) : 0,
			due,
			reps: s.reps ?? 0,
			lapses: s.lapses ?? 0,
			weakPrerequisites: [],
			dependentCount,
			isFoundation,
		};
	}

	const prereqSeen = new Map<string, Set<string>>();
	for (const chain of snapshot.chains ?? []) {
		if (!nodesById.has(chain.conclusion)) continue;
		for (const premiseId of chain.premises) {
			const premiseInfo = nodes[premiseId];
			if (!premiseInfo || premiseInfo.state === "untracked") continue;
			const isWeak =
				premiseInfo.memoryBand === "overdue" ||
				(premiseInfo.retrievability !== null && premiseInfo.retrievability < 0.80);
			if (!isWeak) continue;

			let seen = prereqSeen.get(chain.conclusion);
			if (!seen) {
				seen = new Set();
				prereqSeen.set(chain.conclusion, seen);
			}
			if (seen.has(premiseId)) continue;
			seen.add(premiseId);

			if (!nodes[chain.conclusion]) {
				const conclusionDepCount = dependentCountById.get(chain.conclusion) ?? 0;
				nodes[chain.conclusion] = {
					id: chain.conclusion,
					state: "untracked",
					memoryBand: "untracked",
					retrievability: null,
					stability: 0,
					difficulty: 0,
					due: false,
					reps: 0,
					lapses: 0,
					weakPrerequisites: [],
					dependentCount: conclusionDepCount,
					isFoundation: conclusionDepCount >= 1,
				};
			}
			nodes[chain.conclusion]!.weakPrerequisites.push({
				id: premiseId,
				name: nodesById.get(premiseId)?.name ?? premiseId,
				retrievability: premiseInfo.retrievability ?? 0,
				due: premiseInfo.due,
			});
		}
	}

	let prereqRisk = 0;
	let untrackedFoundations = 0;
	let weakFoundations = 0;
	for (const info of Object.values(nodes)) {
		if (info.weakPrerequisites.length > 0) prereqRisk++;
		if (info.isFoundation) {
			if (info.state === "untracked") untrackedFoundations++;
			else if (info.memoryBand === "overdue" || info.memoryBand === "decaying" || info.due) weakFoundations++;
		}
	}

	let examReadinessPct = 0;
	if (snapshot.nodes.length > 0) {
		let weightedSum = 0;
		let totalWeight = 0;
		for (const node of snapshot.nodes) {
			const dependentCount = dependentCountById.get(node.id) ?? 0;
			const weight = dependentCount >= 1 ? 2 : 1;
			const info = nodes[node.id];
			let nodeScore = 0.35;
			if (info && info.state !== "untracked") {
				if (info.retrievability !== null) {
					nodeScore = info.due ? info.retrievability * 0.6 : info.retrievability;
				} else if (info.state === "new") {
					nodeScore = 0.5;
				}
			}
			weightedSum += weight * nodeScore;
			totalWeight += weight;
		}
		if (totalWeight > 0) {
			examReadinessPct = Math.round(Math.min(100, Math.max(0, (weightedSum / totalWeight) * 100)));
		}
	}

	return {
		nodes,
		counts: {
			tracked,
			strong,
			decaying,
			overdue,
			prereqRisk,
			untrackedFoundations,
			weakFoundations,
		},
		hasCustomWeights,
		reviewCount: Array.isArray(flashcards.reviews) ? flashcards.reviews.length : 0,
		examReadinessPct,
	};
}

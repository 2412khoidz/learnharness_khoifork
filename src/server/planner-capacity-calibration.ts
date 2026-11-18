import { createHash, randomUUID } from "node:crypto";
import {
	isValidDateString, localDateString, normalizeSubjectKey, type CapacityCalibrationUndo, type PlannedBlock, type RecallWorkloadFocus,
} from "../core/planner.ts";
import { computeRecallCapacity, recallOutcome } from "../core/recall-capacity.ts";
import type { CapacityCalibrationPreview } from "../core/learning-capacity.ts";
import { readPlannerConfig, readPlannerLearningCapacityServer, savePlannerConfig } from "./planner.ts";

export class CapacityCalibrationConflict extends Error {}

interface Options {
	date?: string;
	now?: number;
	plannerFile?: string;
	chatsDir?: string;
	flashcardsFile?: string;
}

const revisionOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const blockRevision = ({ recallFocus, ...block }: PlannedBlock) => {
	void recallFocus;
	return revisionOf(block);
};

function blockStart(block: PlannedBlock, date: string) {
	const [year, month, day] = date.split("-").map(Number);
	return new Date(year!, month! - 1, day!, 0, block.startMin).getTime();
}

function calibrationState(options: Options) {
	const now = options.now ?? Date.now();
	const date = isValidDateString(options.date) ? options.date : localDateString(now);
	const { config, report, recallSources } = readPlannerLearningCapacityServer({ ...options, date, now });
	const plan = config.plans[date];
	const sources = new Map(recallSources.map((item) => [item.observation.id, item]));
	const material: unknown[] = [];
	const bySubject = new Map<string, { block: PlannedBlock; date: string }>();
	const muted = new Set(config.mutedSubjects?.map(normalizeSubjectKey));
	const upcoming = Object.entries(config.plans)
		.filter(([day]) => day >= localDateString(now))
		.flatMap(([day, saved]) => saved.blocks.map((block) => ({ block, date: day })))
		.sort((a, b) => blockStart(a.block, a.date) - blockStart(b.block, b.date));
	for (const { block, date: day } of upcoming) {
		const key = normalizeSubjectKey(block.subject ?? "");
		if (block.type !== "study" || !key || muted.has(key) || block.durationMin < 15 ||
			config.logs[day]?.completedBlockIds?.includes(block.id) || blockStart(block, day) <= now || bySubject.has(key)) continue;
		bySubject.set(key, { block, date: day });
	}
	const proposals: CapacityCalibrationPreview["proposals"] = report.subjectBreakdown.flatMap((subject) => {
		const upcomingBlock = bySubject.get(normalizeSubjectKey(subject.subject));
		if (!upcomingBlock) return [];
		const { block, date: blockDate } = upcomingBlock;
		const groups = subject.approvedRecallGroups?.last30 ?? [];
		const ranked = groups.flatMap((group) => {
			if (group.stale) return [];
			const rows = group.answers.flatMap(({ id }) => sources.get(id) ?? []);
			const items = rows.map((item) => item.observation);
			const profile = computeRecallCapacity(items, now);
			if (profile.usable < 2 || !profile.estimate || !items.some((item) => {
				const outcome = recallOutcome(item.verdict);
				return outcome !== null && outcome > 0 && item.help !== "assisted";
			})) return [];
			const partial = items.filter((item) => item.source === "user" && item.help === "independent" && item.verdict === "partial");
			const confirmed = computeRecallCapacity(items.filter((item) => item.source === "user" && item.help === "independent"), now);
			const practice = computeRecallCapacity(partial, now).days >= 2 && confirmed.usable * 2 > profile.usable;
			const task = practice ? [...partial].sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))
				.find((item) => item.feedback?.trim())?.feedback?.trim().slice(0, 250) : undefined;
			return [{
				group, profile, rows, task,
				mode: practice ? "practice" as const : "recheck" as const,
				priority: (1 - profile.estimate.full) * profile.weighted / (profile.weighted + 8),
			}];
		}).sort((a, b) => b.priority - a.priority || a.group.id.localeCompare(b.group.id));
		const top = ranked[0];
		if (!top) return [];
		const focus: RecallWorkloadFocus = {
			topic: top.group.name.trim().slice(0, 160),
			minutes: Math.min(15, 5 * Math.floor(block.durationMin / 15), top.mode === "recheck" ? 10 : 15),
			mode: top.mode,
			...(top.task ? { task: top.task } : {}),
		};
		if (revisionOf(focus) === revisionOf(block.recallFocus ?? null)) return [];
		material.push([blockRevision(block), top.rows.map(({ fingerprint, observation }) => [observation.id, fingerprint, observation.help, observation.answeredAt])]);
		return [{
			id: JSON.stringify([blockDate, block.id]),
			blockId: block.id,
			date: blockDate,
			subject: subject.subject,
			title: block.title,
			startTime: block.startTime,
			endTime: block.endTime,
			previous: block.recallFocus,
			focus,
			graded: top.profile.graded,
			days: top.profile.days,
			provisional: top.profile.provisional,
			helpUnknown: top.profile.helpUnknown,
			full: top.profile.estimate!.full,
		}];
	}).slice(0, 50);
	const realism = {
		current: config.realismFactor ?? null,
		recommended: report.recommendedRealismFactor,
	};
	const revision = revisionOf([config.updatedAt, date, localDateString(now), plan, realism, proposals, material]);
	const preview: CapacityCalibrationPreview = { date, revision, proposals, realism, plannedStudyHours: plan?.plannedStudyHours ?? null, undoId: config.lastCapacityCalibration?.id ?? null };
	return { config, now, preview };
}

export function previewCapacityCalibration(options: Options = {}) {
	return calibrationState(options).preview;
}

export function applyCapacityCalibration(input: { revision: string; items: readonly string[]; realism: boolean }, options: Options = {}) {
	const { config, now, preview } = calibrationState(options);
	if (preview.revision !== input.revision) throw new CapacityCalibrationConflict("The plan or recall evidence changed. Refresh the calibration preview.");
	const chosen = new Set(input.items);
	const proposals = preview.proposals.filter((item) => chosen.has(item.id));
	if (proposals.length !== chosen.size || chosen.size !== input.items.length || (!input.realism && !chosen.size)) throw new Error("Select valid calibration changes.");
	const undo: CapacityCalibrationUndo = {
		id: randomUUID(), date: preview.date, blocks: [],
		...(input.realism ? { realism: { before: preview.realism.current, after: preview.realism.recommended } } : {}),
	};
	const plans = { ...config.plans };
	for (const { date, blockId, focus } of proposals) {
		const plan = plans[date]!;
		plans[date] = { ...plan, blocks: plan.blocks.map((block) => {
			if (block.id !== blockId) return block;
			undo.blocks.push({ id: block.id, date, revision: blockRevision(block), before: block.recallFocus, after: focus });
			return { ...block, recallFocus: focus };
		}) };
	}
	savePlannerConfig({
		...config,
		...(undo.realism ? { realismFactor: undo.realism.after } : {}),
		plans,
		lastCapacityCalibration: undo,
		updatedAt: new Date(now).toISOString(),
	}, options.plannerFile);
	return { undoId: undo.id, applied: undo.blocks.length, realismApplied: Boolean(undo.realism) };
}

export function undoCapacityCalibration(id: string, options: Options = {}) {
	const config = readPlannerConfig(options.plannerFile);
	const undo = config.lastCapacityCalibration;
	if (!undo || undo.id !== id) throw new CapacityCalibrationConflict("This calibration is no longer the latest one.");
	if (undo.realism && config.realismFactor !== undo.realism.after) throw new CapacityCalibrationConflict("Realism was edited after calibration.");
	const plans = { ...config.plans };
	for (const change of undo.blocks) {
		const plan = plans[change.date];
		const current = plan?.blocks.find((block) => block.id === change.id);
		if (!plan || !current || config.logs[change.date]?.completedBlockIds?.includes(change.id) ||
			blockRevision(current) !== change.revision || revisionOf(current.recallFocus ?? null) !== revisionOf(change.after)) {
			throw new CapacityCalibrationConflict("A study block changed after calibration.");
		}
		plans[change.date] = { ...plan, blocks: plan.blocks.map((block) => block.id === change.id ? { ...block, recallFocus: change.before } : block) };
	}
	savePlannerConfig({
		...config,
		...(undo.realism ? { realismFactor: undo.realism.before ?? undefined } : {}),
		plans,
		lastCapacityCalibration: undefined,
		updatedAt: new Date(options.now ?? Date.now()).toISOString(),
	}, options.plannerFile);
	return { undone: undo.blocks.length, realismRestored: Boolean(undo.realism) };
}

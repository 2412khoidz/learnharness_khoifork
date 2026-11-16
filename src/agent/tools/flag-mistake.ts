import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	FLAG_MISTAKE_TOOL,
	FLAG_MISTAKE_VERDICTS,
	resolveExplainTargetCallId,
	type FlagMistakeDetails,
} from "../../core/mistakes.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { invalidInputResult } from "../tool-execute.ts";

/**
 * flag_mistake — marks a graded free-recall (`explain` / `recall`) answer
 * as a mistake so it enters the Mistake Log (`/mistakes`) for error-pattern
 * analysis and spaced review. Only armed in free-recall mode (`explain === true`)
 * so default MCQ mode has zero extra tools or calls, and never called when
 * the learner's free-recall response is right.
 */

export interface FlagMistakeToolContext {
	chatId: string;
	chatStore?: {
		getChat: (id: string) => { messages: readonly LhMessage[] } | undefined | null;
	};
}

const oneLine = (value: string, max: number): string => value.replace(/\s+/g, " ").trim().slice(0, max);

const verdictSchema = Type.Union(
	FLAG_MISTAKE_VERDICTS.map((verdict) => Type.Literal(verdict)),
	{
		description:
			"'correct' for a correct response; 'wrong' for an incorrect claim or model; 'partial' when a material point is missing; 'dont_know' if the learner does not know; 'uncertain' if there is not enough evidence.",
	},
);

const flagMistakeInput = Type.Object({
	verdict: verdictSchema,
	summary: Type.String({
		minLength: 1,
		description:
			"One concise sentence stating specifically what was wrong, missing, or confused relative to the committed answer.",
	}),
	strengths: Type.Optional(Type.String({ description: "What the learner got right, if anything." })),
	missing: Type.Optional(Type.String({ description: "The specific missing or incorrect reasoning, if any." })),
	correction: Type.Optional(Type.String({ description: "A concrete correction, if needed." })),
	toolCallId: Type.Optional(
		Type.String({
			description: "Optional tool call id of the explain or recall check being graded; defaults to the latest answered check.",
		}),
	),
});

type FlagMistakeInput = Static<typeof flagMistakeInput>;

export function flagMistakeTools(ctx: FlagMistakeToolContext): Record<string, AgentTool<any>> {
	const tool: AgentTool<typeof flagMistakeInput, any> = {
		name: FLAG_MISTAKE_TOOL,
		label: FLAG_MISTAKE_TOOL,
		description:
			"Record a structured assessment of an answered free-recall (`explain` or `recall`) check. " +
			"Distinguish correct, partial, wrong, don't know, and uncertain; only incorrect or incomplete answers enter the Mistake Log.",
		parameters: flagMistakeInput,
		execute: async (_callId, raw) => {
			const input = raw as FlagMistakeInput;
			const summary = oneLine(input.summary ?? "", 400);
			if (!summary) {
				return invalidInputResult(FLAG_MISTAKE_TOOL, ["summary must state what was wrong or missing."]);
			}
			const chat = ctx.chatStore?.getChat(ctx.chatId);
			let targetToolCallId = input.toolCallId?.trim() || undefined;
			if (chat) {
				const resolved = resolveExplainTargetCallId(chat.messages, targetToolCallId);
				if (!resolved) {
					return invalidInputResult(FLAG_MISTAKE_TOOL, [
						"No answered non-dismissed explain or recall check was found to record.",
					]);
				}
				targetToolCallId = resolved;
			}
			const details: FlagMistakeDetails = {
				...(targetToolCallId ? { targetToolCallId } : {}),
				verdict: input.verdict,
				summary,
				...(input.strengths?.trim() ? { strengths: input.strengths.trim().slice(0, 700) } : {}),
				...(input.missing?.trim() ? { missing: input.missing.trim().slice(0, 700) } : {}),
				...(input.correction?.trim() ? { correction: input.correction.trim().slice(0, 700) } : {}),
			};
			return {
				content: [{ type: "text", text: input.verdict === "correct" || input.verdict === "uncertain" ? `Assessment recorded (${input.verdict}): ${summary}` : `Recorded in Mistake Log (${input.verdict}): ${summary}` }],
				details,
			};
		},
	};
	return { [FLAG_MISTAKE_TOOL]: tool };
}

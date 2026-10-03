// How a run's prompt tokens split, for the Cost tab's Prompt composition and
// the input areas of Spend by area (#5295). Two reads carry the split.
//
// `get_run_context`'s composition sums every request window the run recorded
// (ADR-200): the system, steering, tools, context and conversation blocks,
// each its byte share of the prompt total the vendor reported. Only an
// in-app run and a wrapped run whose calls went through the local model
// proxy record windows, and a wrapped window has no context block.
//
// `get_run_cost`'s token sources are the rollup's sums of what the recorder
// measured on each call: tool definitions, context frames and steering. A
// Claude Code session the proxy did not carry still has its steering count
// (ADR-062, amendment of 2026-10-02).
//
// The windows win when the run recorded any, since they split the whole
// request. Without them the sources fill the three parts they measure, and
// conversation and system stay null. A part no source measured is null and
// reads "not recorded", never zero.
import { type Money, shareOfMicros } from "@/data/contracts/money";
import type { RunCostTokenSources } from "@/data/contracts/run";
import type { ContextComposition } from "@/data/contracts/run-context";

/** Prompt composition's parts, in the panel's order. */
export const PROMPT_PARTS = [
  "conversation",
  "context",
  "definitions",
  "steering",
  "system",
] as const;
export type PromptPart = (typeof PROMPT_PARTS)[number];

export type PromptSplit = {
  /** `windows`: summed over the request windows. `sources`: the rollup's measured sources. */
  from: "windows" | "sources";
  /** Each part's tokens; null for a part nothing measured. */
  parts: Record<PromptPart, number | null>;
  /**
   * What a part's share is of: the windows' prompt total, or the run's input
   * tokens for the sources. Null when that total is not known.
   */
  whole: number | null;
};

/**
 * The run's prompt split: the windows' composition when the run recorded
 * one, else the rollup's measured sources, else null.
 */
export function promptSplit(
  composition: ContextComposition | null,
  sources: RunCostTokenSources | null,
  inputTokens: number | null,
): PromptSplit | null {
  if (composition !== null) {
    const { blocks } = composition;
    return {
      from: "windows",
      parts: {
        conversation: blocks.conversation,
        context: blocks.context,
        definitions: blocks.tools,
        steering: blocks.steering,
        system: blocks.system,
      },
      whole: composition.promptTokens,
    };
  }
  if (sources === null) return null;
  return {
    from: "sources",
    parts: {
      conversation: null,
      context: sources.contextFrameTokens,
      definitions: sources.toolDefinitionTokens,
      steering: sources.steeringTokens,
      system: null,
    },
    whole: inputTokens,
  };
}

/** `part` over `whole`, at most 1; null when either is unknown or the whole is 0. */
export function shareOf(
  part: number | null,
  whole: number | null,
): number | null {
  if (part === null || whole === null || whole <= 0) return null;
  return Math.min(1, part / whole);
}

/**
 * The input areas of Spend by area the windows fill, in tokens.
 *
 * - Prompt is the conversation block of the run's first request. The first
 *   request is the first window that declared tools, so a harness's side
 *   call that came first, such as a session title, is not taken for it
 *   (ADR-062, amendment of 2026-10-02).
 * - Follow-up prompts is every other request's conversation block. Each
 *   request re-sends the conversation so far, which is why the area costs
 *   more than the words the person added.
 * - System is every request's system block.
 * - Tool definitions is every request's tools block.
 * - Context is every request's steering and context blocks together, the two
 *   sources the area holds.
 *
 * Each sums to the windows' prompt total with nothing counted twice. A
 * figure whose block no window carried is null.
 */
export type WindowAreas = {
  initial: number | null;
  followUp: number | null;
  system: number | null;
  definitions: number | null;
  context: {
    tokens: number;
    steering: number | null;
    context: number | null;
  } | null;
};

export function windowAreas(
  composition: ContextComposition | null,
): WindowAreas | null {
  if (composition === null) return null;
  const { blocks } = composition;
  const initial = composition.initialConversationTokens;
  // The first request's conversation is part of the block's sum whenever it
  // was counted, so what is left is the other requests'.
  const followUp =
    blocks.conversation === null
      ? null
      : Math.max(0, blocks.conversation - (initial ?? 0));
  const context =
    blocks.steering === null && blocks.context === null
      ? null
      : {
          tokens: (blocks.steering ?? 0) + (blocks.context ?? 0),
          steering: blocks.steering,
          context: blocks.context,
        };
  return {
    initial,
    followUp,
    system: blocks.system,
    definitions: blocks.tools,
    context,
  };
}

/**
 * What `tokens` of the run's input cost: the input classes' recorded cost
 * times the tokens' share of the run's input tokens. It apportions money the
 * rollup recorded at the run's average input rate and prices nothing new, so
 * it is an estimate. Null when the input is unpriced, has no tokens, or the
 * tokens are more than the run counted.
 */
export function inputCostOf(
  tokens: number | null,
  input: Money | null,
  inputTokens: number | null,
): Money | null {
  if (tokens === null || input === null) return null;
  const share = shareOf(tokens, inputTokens);
  if (share === null || tokens > (inputTokens ?? 0)) return null;
  return shareOfMicros(input, share);
}

/** The tools' result tokens summed; null when no tool recorded any. */
export function resultTokensOf(
  byTool: readonly { resultTokens: number | null }[] | null,
): number | null {
  const recorded = (byTool ?? []).flatMap((tool) =>
    tool.resultTokens === null ? [] : [tool.resultTokens],
  );
  return recorded.length === 0
    ? null
    : recorded.reduce((sum, tokens) => sum + tokens, 0);
}

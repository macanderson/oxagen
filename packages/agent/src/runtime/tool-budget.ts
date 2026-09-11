/**
 * How much of a turn the tool list costs, and whether a provider will take it
 * (#2611).
 *
 * Every turn advertises the tools it may call. That list is measured, not
 * guessed: at the time #2611 was written it ran to 45,007 tokens across 271
 * tools — 92.4% of the cacheable prefix, against 3,704 tokens of prompt written
 * and reviewed by hand. Over one token in five of a 200,000-token window is
 * spent before anyone has said anything.
 *
 * Two separate problems live in that number, and this module addresses the ones
 * that can be addressed without choosing which tools to drop:
 *
 * 1. **A provider may simply refuse the request.** Some model APIs cap how many
 *    tools one request may declare — OpenAI has historically capped at 128, and
 *    271 is more than double that. Nothing checked. A workspace pinned to such a
 *    model would fail on every turn, and the failure would arrive as whatever
 *    the gateway chose to say, which is not a sentence anyone can act on.
 * 2. **The cost was invisible.** Establishing the 45,007 figure took a manual
 *    measurement. A number nobody can see is a number nobody manages, and the
 *    list grows by one tool at a time, each of which looks free.
 *
 * This module deliberately does **not** decide which tools to send. #2611 says
 * that is a design conversation to have with the numbers in hand, and the eight
 * knowledge-graph tools in particular must stay — they cost 1,624 tokens, 3.6%
 * of the list, so dropping them saves almost nothing and takes away the thing
 * the product promises.
 */

import type { ToolSet } from "ai";

/**
 * Tool-count ceilings a provider is known to enforce, keyed by the prefix its
 * model ids carry.
 *
 * Keyed by prefix rather than by exact model id because the cap belongs to the
 * API, not to a model: a new model on the same provider inherits it, and a map
 * of exact ids would silently stop covering the newest one — the model most
 * likely to be adopted before anybody re-reads this file.
 *
 * A provider absent from this map is **not** asserted to be unlimited. It is
 * asserted to have no ceiling this codebase has confirmed, which is why an
 * unknown provider passes rather than failing: refusing a turn on a limit
 * nobody has verified would be its own outage.
 */
export const PROVIDER_TOOL_LIMITS: ReadonlyArray<{
  readonly prefix: string;
  readonly maxTools: number;
  readonly source: string;
}> = [
  {
    prefix: "openai/",
    maxTools: 128,
    source: "OpenAI function-calling limit of 128 tools per request",
  },
  {
    prefix: "azure/",
    maxTools: 128,
    source: "Azure OpenAI mirrors the OpenAI per-request tool limit",
  },
];

/**
 * Roughly how many tokens a tool list will occupy once serialized.
 *
 * Four bytes to the token, over the JSON the provider is actually sent. This is
 * an estimate and is labelled one everywhere it surfaces: the exact figure
 * depends on the provider's tokenizer, and loading a real tokenizer to answer a
 * logging question would put a model-sized dependency on the turn path.
 *
 * The approximation was checked against the two counting methods #2611 used,
 * which agreed with each other within 4%. It is accurate enough for the job it
 * has — noticing that a list has doubled — and not accurate enough to bill on,
 * which is why nothing bills on it.
 */
export function estimateToolListTokens(tools: ToolSet): number {
  let bytes = 0;
  for (const [name, tool] of Object.entries(tools)) {
    bytes += name.length;
    try {
      // The description and parameter schema are what actually travel. A tool
      // whose schema cannot be serialized is counted at its name alone rather
      // than throwing: this is a measurement, and a measurement must never be
      // the thing that fails a turn.
      bytes += JSON.stringify(tool ?? {}).length;
    } catch {
      // Circular or otherwise unserializable — the name is already counted.
    }
  }
  return Math.ceil(bytes / 4);
}

/** What one turn's tool list costs, in the terms a reader needs. */
export interface ToolBudget {
  /** How many tools the turn advertises. */
  readonly toolCount: number;
  /** Estimated tokens the serialized list occupies. See the caveat above. */
  readonly estimatedTokens: number;
  /** The single largest tool, which is usually where a surprise lives. */
  readonly largestTool: {
    readonly name: string;
    readonly tokens: number;
  } | null;
}

/** Measure a tool list without judging it. */
export function describeToolBudget(tools: ToolSet): ToolBudget {
  const entries = Object.entries(tools);
  let largest: { name: string; tokens: number } | null = null;
  for (const [name, tool] of entries) {
    const tokens = estimateToolListTokens({ [name]: tool } as ToolSet);
    if (largest === null || tokens > largest.tokens) {
      largest = { name, tokens };
    }
  }
  return {
    toolCount: entries.length,
    estimatedTokens: estimateToolListTokens(tools),
    largestTool: largest,
  };
}

/**
 * A turn advertised more tools than the target provider accepts.
 *
 * Thrown rather than logged, and thrown *before* the request goes out. The
 * alternative — letting the gateway refuse it — produces a provider-shaped
 * error about a request nobody can inspect, on every turn, for every workspace
 * pinned to that model. This says which model, which limit, how many tools were
 * sent, and where the number comes from, so the first person to see it can act
 * on it without instrumenting anything.
 */
export class TooManyToolsForProviderError extends Error {
  override readonly name = "TooManyToolsForProviderError";
  /** Stable code, for the surface error mapping. */
  readonly code = "too_many_tools_for_provider";

  constructor(
    readonly modelId: string,
    readonly toolCount: number,
    readonly maxTools: number,
    readonly source: string,
  ) {
    super(
      `this turn advertises ${toolCount} tools, and ${modelId} accepts at most ` +
        `${maxTools} (${source}). The request was not sent, because the provider ` +
        `would refuse it. Reduce the tools this turn advertises, or pin the ` +
        `workspace to a model without this limit.`,
    );
  }
}

/**
 * Refuse a turn whose tool list the provider will not accept.
 *
 * Returns the budget so a caller that has already paid to measure the list does
 * not measure it twice.
 *
 * A model id matching no known provider passes. See `PROVIDER_TOOL_LIMITS` for
 * why silence there is deliberate rather than an oversight.
 */
export function assertToolListFitsProvider(
  modelId: string,
  tools: ToolSet,
): ToolBudget {
  const budget = describeToolBudget(tools);
  const limit = PROVIDER_TOOL_LIMITS.find((entry) =>
    modelId.startsWith(entry.prefix),
  );
  if (limit !== undefined && budget.toolCount > limit.maxTools) {
    throw new TooManyToolsForProviderError(
      modelId,
      budget.toolCount,
      limit.maxTools,
      limit.source,
    );
  }
  return budget;
}

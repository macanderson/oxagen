// This agent's own 30-day token rollup, read from its row of `get_spend` at
// the agent level (spec §12.6; pages/agent.md, "Every token figure is this
// agent's own rollup"). The Overview's token panel, its Last 30 days tiles
// and the Activity tab's accounting all read this one function, so the three
// cannot print different totals.
//
// The rollup records six classes: input (uncached), cache read, cache write
// at five minutes and at an hour, output and reasoning. The design's eight
// classes split input further, into conversation, tool results, context
// frames, tool definitions, steering and system. The row carries four of
// those six as its runs' sums (#5295): tool definitions, context frames and
// steering as the recorder measured them on each call, and tool results from
// the tools' result tokens. Conversation and system come from the runs'
// request windows, which the rollup stores per run and `get_spend` sums
// (#5341). Each is an estimate the input already counts, and one no run
// measured stays null rather than zero.
import type { SpendReport } from "@/data/contracts/spend";

export type AgentSpendRow = SpendReport["rows"][number];

export type TokenRollup = {
  /** Every token the rollup counted: input of every kind, output and reasoning. */
  total: number;
  /** Input of every kind: uncached, cache read and both cache writes. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  inputUncached: number;
  output: number;
  reasoning: number;
  /** Cache read over input; null when no input token was recorded. */
  cacheRate: number | null;
  /** Mean tokens per run; null with no run. */
  perRun: number | null;
  /** Mean input tokens per model call; null with no call. */
  perCall: number | null;
  /**
   * The conversation block of every request window the runs recorded,
   * summed. Each request re-sends the conversation so far, tool results
   * included. Null when no run recorded a window.
   */
  conversation: number | null;
  /** The system block of every request window, summed; null when no run recorded one. */
  system: number | null;
  /** The runs' tool definition tokens summed; null when no run measured them. */
  toolDefinitions: number | null;
  /** The runs' context frame tokens summed; null when no run measured them. */
  contextFrames: number | null;
  /** The runs' steering tokens summed; null when no run measured them. */
  steering: number | null;
  /** The runs' tool result tokens summed; null when no call recorded them. */
  toolResults: number | null;
};

export function tokenRollup(row: AgentSpendRow): TokenRollup {
  const t = row.tokens;
  const cacheWrite = t.cache_write_5m + t.cache_write_1h;
  const input = t.input_uncached + t.cache_read + cacheWrite;
  const total = input + t.output + t.reasoning;
  // A row read before the sources or the windows were summed carries none,
  // and each reads not recorded.
  const sources = row.tokenSources;
  const windows = row.windows?.blocks;
  return {
    total,
    input,
    cacheRead: t.cache_read,
    cacheWrite,
    inputUncached: t.input_uncached,
    output: t.output,
    reasoning: t.reasoning,
    cacheRate: input === 0 ? null : t.cache_read / input,
    perRun: row.runs === 0 ? null : Math.round(total / row.runs),
    perCall: row.calls === 0 ? null : Math.round(input / row.calls),
    conversation: windows?.conversation ?? null,
    system: windows?.system ?? null,
    toolDefinitions: sources?.toolDefinitionTokens ?? null,
    contextFrames: sources?.contextFrameTokens ?? null,
    steering: sources?.steeringTokens ?? null,
    toolResults: sources?.toolResultTokens ?? null,
  };
}

/** The design's eight classes, in its order; `recorded` names the rollup field behind each. */
export const TOKEN_CLASSES = [
  { key: "conversation", recorded: "conversation" },
  { key: "toolResults", recorded: "toolResults" },
  { key: "contextFrames", recorded: "contextFrames" },
  { key: "toolDefinitions", recorded: "toolDefinitions" },
  { key: "steering", recorded: "steering" },
  { key: "system", recorded: "system" },
  { key: "output", recorded: "output" },
  { key: "reasoning", recorded: "reasoning" },
] as const satisfies readonly {
  key: string;
  recorded:
    | "output"
    | "reasoning"
    | "conversation"
    | "system"
    | "toolResults"
    | "contextFrames"
    | "toolDefinitions"
    | "steering";
}[];

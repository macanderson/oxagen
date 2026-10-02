// selection.ts: ask a model which of a server's tools fits each task in
// tests/selection.jsonl, and count how often it picked right (lane M16;
// mcp-studio-spec, Try it and tests: selection tests).
//
// A selection run spends model tokens, so it runs only when a person asks
// for one. No compile check, CI job, or schedule calls runSelection.
//
// This module calls no model. The caller passes a SelectionModel, and in
// Oxagen that model is built on @oxagen/ai, which every model call goes
// through: it meters the call, and modelIdOf() resolves the model on the
// workspace's route. mcp-studio does not depend on @oxagen/ai, because that
// package brings the database, billing, and telemetry clients with it, and
// the relay and the steering check load mcp-studio.
import { z } from "zod";
import type { EffectiveDefinition } from "../contract/manifest";

/**
 * One task to put to the model. A tests/selection.jsonl line, as
 * parseSelectionTests returns it, is one. expect is null when no tool fits
 * the task, so the right answer is to pick none.
 */
export interface SelectionCase {
  task: string;
  expect: string | null;
}

/** The system text a selection run sends with every task. */
export const SELECTION_INSTRUCTIONS =
  "You pick the tool an agent should call for a task. Pick the one tool that best fits the task. " +
  "If no tool fits, pick none.";

/** What a selection run asks the model, once per task. */
export interface SelectionRequest {
  /** SELECTION_INSTRUCTIONS, as the system text. */
  instructions: string;
  /** The task, as a person would ask the agent. */
  task: string;
  /** The tools to choose from, each as the agent receives it in tools/list. */
  tools: readonly EffectiveDefinition[];
}

/** The model's answer for one task: the tool it picked, or null when it picked none. */
export const selectionReplySchema = z
  .object({
    tool: z.string().min(1).nullable().describe("The full name of the tool the model picked, or null for none."),
  })
  .strict();
export type SelectionReply = z.output<typeof selectionReplySchema>;

/**
 * The model a selection run asks. An implementation shows the model
 * request.tools, sends request.instructions as the system text and
 * request.task as the user's message, and resolves to a SelectionReply: the
 * full name of the tool the model picked, or null when it picked none. It
 * runs no tool. Offering the tools as tools the model can call comes closest
 * to what an agent sees: the pick is the first tool the model calls, and
 * none when it calls none. A structured answer over the same definitions
 * also works.
 *
 * Build it on @oxagen/ai, with the model from modelIdOf(), and never on a
 * provider SDK, so the call is metered and routed like the workspace's other
 * model calls.
 *
 * The run checks the reply against selectionReplySchema, so an
 * implementation may pass a parsed answer through as it came. A reply that
 * does not fit counts as malformed. A rejection stops the run.
 */
export interface SelectionModel {
  choose(request: SelectionRequest, signal?: AbortSignal): Promise<unknown>;
}

/**
 * How one task came out.
 *
 * - hit: the model picked the expected tool, or picked none when none fits.
 * - miss: the model picked another tool, or picked none when one fits.
 * - malformed: the reply could not be read, or it named a tool the server does not offer.
 * - skipped: the task expects a tool the server does not offer, so the run did not ask the model.
 */
export type SelectionOutcome =
  | { status: "hit" | "miss"; chosen: string | null }
  | { status: "malformed" | "skipped"; reason: string };

export type SelectionCaseResult = {
  /** The task's place in the run, from 1: its line in tests/selection.jsonl. */
  line: number;
  task: string;
  /** The tool that fits the task, or null when none does. */
  expected: string | null;
} & SelectionOutcome;

/** How many tasks came out each way. hits, misses, malformed, and skipped add up to total. */
export interface SelectionCounts {
  total: number;
  hits: number;
  misses: number;
  malformed: number;
  skipped: number;
}

export interface SelectionReport {
  /** One result per task, in the order the tasks were given. */
  cases: SelectionCaseResult[];
  counts: SelectionCounts;
}

export const SELECTION_RUN_ERROR_CODES = ["no_tools", "duplicate_tool", "model_failed"] as const;
export type SelectionRunErrorCode = (typeof SELECTION_RUN_ERROR_CODES)[number];

/**
 * Why a selection run stopped.
 *
 * - no_tools: the server offers no tool, so there is nothing to choose from.
 * - duplicate_tool: two tools share a name, so a reply could not say which one the model picked.
 * - model_failed: the model call for one task failed. The run asks no more tasks.
 */
export class SelectionRunError extends Error {
  readonly code: SelectionRunErrorCode;
  /** For model_failed, the task whose model call failed. Null otherwise. */
  readonly line: number | null;
  /** The tasks the run finished before it stopped, in order. */
  readonly completed: readonly SelectionCaseResult[];

  constructor(
    code: SelectionRunErrorCode,
    message: string,
    options: { line?: number; completed?: readonly SelectionCaseResult[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SelectionRunError";
    this.code = code;
    this.line = options.line ?? null;
    this.completed = options.completed ?? [];
  }
}

/**
 * The tools a selection run offers: each imported tool's definition, in the
 * order the server lists them. It takes the compile output (CompiledServer)
 * or a tool manifest entry (ManifestServer).
 *
 * In search mode the agent reaches these tools through search, describe, and
 * call. A selection run offers them directly, because it tests whether each
 * tool's definition leads a model to that tool. A search-mode server can
 * import more tools than a provider takes in one request, so the caller
 * checks the count before it asks.
 */
export function selectionTools(server: {
  tools: Readonly<Record<string, { definition: EffectiveDefinition }>>;
}): EffectiveDefinition[] {
  return Object.values(server.tools).map((tool) => tool.definition);
}

/** Read the model's reply and compare it with the expected tool. */
function judge(reply: unknown, expected: string | null, offered: ReadonlySet<string>): SelectionOutcome {
  const parsed = selectionReplySchema.safeParse(reply);
  if (!parsed.success) {
    return {
      status: "malformed",
      reason: "The model's reply is not { tool: <name or null> }, so the run could not tell which tool it picked.",
    };
  }
  const chosen = parsed.data.tool;
  if (chosen !== null && !offered.has(chosen)) {
    return { status: "malformed", reason: `The model picked ${chosen}, which the server does not offer.` };
  }
  return { status: chosen === expected ? "hit" : "miss", chosen };
}

const COUNT_KEY = { hit: "hits", miss: "misses", malformed: "malformed", skipped: "skipped" } as const;

function countOutcomes(cases: readonly SelectionCaseResult[]): SelectionCounts {
  const counts: SelectionCounts = { total: cases.length, hits: 0, misses: 0, malformed: 0, skipped: 0 };
  for (const result of cases) counts[COUNT_KEY[result.status]] += 1;
  return counts;
}

/**
 * Ask the model which tool fits each task, and report each hit and miss.
 *
 * The run asks one task at a time, in order, so a failed model call stops it
 * before it spends more. It throws a SelectionRunError with code
 * model_failed, which holds the tasks finished so far. When the signal
 * aborts, the run throws the signal's reason and asks no more tasks.
 */
export async function runSelection(
  tools: readonly EffectiveDefinition[],
  cases: readonly SelectionCase[],
  model: SelectionModel,
  signal?: AbortSignal,
): Promise<SelectionReport> {
  if (tools.length === 0) {
    throw new SelectionRunError("no_tools", "The server offers no tool, so a selection run has nothing to choose from.");
  }
  const offered = new Set<string>();
  for (const tool of tools) {
    if (offered.has(tool.name)) {
      throw new SelectionRunError(
        "duplicate_tool",
        `Two tools are named ${tool.name}, so a reply could not say which one the model picked.`,
      );
    }
    offered.add(tool.name);
  }

  const results: SelectionCaseResult[] = [];
  for (const [index, test] of cases.entries()) {
    signal?.throwIfAborted();
    const line = index + 1;
    const task = { line, task: test.task, expected: test.expect };
    if (test.expect !== null && !offered.has(test.expect)) {
      results.push({
        ...task,
        status: "skipped",
        reason: `The server does not offer ${test.expect}, so the run did not ask the model. Import the tool, or correct the task's expect.`,
      });
      continue;
    }
    let reply: unknown;
    try {
      reply = await model.choose({ instructions: SELECTION_INSTRUCTIONS, task: test.task, tools }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new SelectionRunError(
        "model_failed",
        `The model call for task ${line} failed, so the run stopped after ${results.length} of ${cases.length} tasks.`,
        { line, completed: results, cause: error },
      );
    }
    results.push({ ...task, ...judge(reply, test.expect, offered) });
  }
  return { cases: results, counts: countOutcomes(results) };
}

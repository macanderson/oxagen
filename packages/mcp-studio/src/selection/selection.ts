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

/** A server's selection tests, relative to its folder under tools/servers/. */
export const SELECTION_TESTS_FILE = "tests/selection.jsonl";

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
 * does not fit counts as malformed. A rejection marks that task error and
 * stops the run from starting more tasks.
 *
 * The run asks up to SELECTION_CONCURRENCY tasks at once, so choose() must
 * take several calls at the same time. When the signal aborts, choose()
 * should reject promptly. The run does not wait for it: it stops at once and
 * reports the task as not_run.
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
 * - error: the model call failed. reason holds the provider's error code and message.
 * - not_run: the run stopped before the model answered, so the task has no result.
 */
export type SelectionOutcome =
  | { status: "hit" | "miss"; chosen: string | null }
  | { status: "malformed" | "skipped" | "error" | "not_run"; reason: string };

export type SelectionCaseResult = {
  /** The task's place in the run, from 1: its line in tests/selection.jsonl. */
  line: number;
  task: string;
  /** The tool that fits the task, or null when none does. */
  expected: string | null;
} & SelectionOutcome;

/** How many tasks came out each way. hits, misses, malformed, skipped, errors, and notRun add up to total. */
export interface SelectionCounts {
  total: number;
  hits: number;
  misses: number;
  malformed: number;
  skipped: number;
  errors: number;
  notRun: number;
}

/**
 * Why a run stopped before every task had an answer.
 *
 * - deadline: the signal aborted. The caller aborts it at the run's deadline.
 * - model_failed: a model call failed, so the run started no more tasks.
 */
export type SelectionStop = "deadline" | "model_failed";

export interface SelectionReport {
  /** One result per task, in the order the tasks were given. */
  cases: SelectionCaseResult[];
  counts: SelectionCounts;
  /**
   * Why the run stopped early, or null when it asked every task. A run that
   * stops still reports every task that finished, so the answers already
   * billed are never lost. Each task it did not ask is not_run. A run that
   * finished before the signal aborted reads null.
   */
  stopped: SelectionStop | null;
}

/**
 * The most tasks one selection run asks. Each task is one model call, billed
 * to the workspace, so the cap bounds what one click can spend.
 */
export const SELECTION_TASKS_MAX = 50;

/**
 * The most model calls one selection run has waiting at once. Fifty tasks
 * take ten rounds, so a model that answers in 6 seconds finishes a full run in
 * about a minute. A small number keeps one run from flooding the provider or
 * the workspace's rate limit.
 */
export const SELECTION_CONCURRENCY = 5;

export const SELECTION_RUN_ERROR_CODES = ["no_tools", "duplicate_tool", "too_many_tasks", "model_failed"] as const;
export type SelectionRunErrorCode = (typeof SELECTION_RUN_ERROR_CODES)[number];

/**
 * Why a selection run stopped.
 *
 * - no_tools: the server offers no tool, so there is nothing to choose from.
 * - duplicate_tool: two tools share a name, so a reply could not say which one the model picked.
 * - too_many_tasks: the run has more than SELECTION_TASKS_MAX tasks. It asks the model nothing.
 * - model_failed: every model call the run made failed, so no task has an
 *   answer to report. A run in which any task got an answer returns its
 *   results instead, with the failed tasks marked error.
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

const COUNT_KEY = {
  hit: "hits",
  miss: "misses",
  malformed: "malformed",
  skipped: "skipped",
  error: "errors",
  not_run: "notRun",
} as const;

function countOutcomes(cases: readonly SelectionCaseResult[]): SelectionCounts {
  const counts: SelectionCounts = {
    total: cases.length,
    hits: 0,
    misses: 0,
    malformed: 0,
    skipped: 0,
    errors: 0,
    notRun: 0,
  };
  for (const result of cases) counts[COUNT_KEY[result.status]] += 1;
  return counts;
}

/** The reason a task without a result gives. */
const NOT_RUN_REASON = "The run stopped before the model answered this task, so it has no result.";

/** The most characters of a provider's error message a failed task keeps. */
const FAILURE_MESSAGE_MAX = 500;

/** The reason a failed task gives: the provider's error code, when it has one, and its message. */
function failureReason(error: unknown): string {
  const raw = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const code = typeof raw === "string" && raw !== "" ? ` (${raw})` : "";
  const message = error instanceof Error ? error.message : String(error);
  const clipped = message.length > FAILURE_MESSAGE_MAX ? `${message.slice(0, FAILURE_MESSAGE_MAX)}...` : message;
  return `The model call failed${code}: ${clipped}`;
}

/** How one model call ended. */
type Asked = { kind: "answer"; reply: unknown } | { kind: "failed"; error: unknown } | { kind: "stopped" };

const STOPPED: Asked = { kind: "stopped" };

/** A promise that resolves to STOPPED when the signal aborts. It never settles otherwise. */
function whenAborted(signal: AbortSignal): Promise<Asked> {
  if (signal.aborted) return Promise.resolve(STOPPED);
  return new Promise<Asked>((resolve) => signal.addEventListener("abort", () => resolve(STOPPED), { once: true }));
}

/**
 * Ask the model about one task. It settles when the model answers or fails,
 * or when `aborted` resolves, whichever comes first, so a call that ignores
 * the signal cannot hold the run past it. A call that fails after the signal
 * aborted counts as stopped, not failed.
 */
function ask(
  model: SelectionModel,
  request: SelectionRequest,
  signal: AbortSignal | undefined,
  aborted: Promise<Asked> | null,
): Promise<Asked> {
  const call = new Promise<unknown>((resolve) => resolve(model.choose(request, signal))).then(
    (reply): Asked => ({ kind: "answer", reply }),
    (error: unknown): Asked => (signal?.aborted === true ? STOPPED : { kind: "failed", error }),
  );
  return aborted === null ? call : Promise.race([call, aborted]);
}

/**
 * Ask the model which tool fits each task, and report each hit and miss.
 *
 * Before it asks anything, the run refuses a server with no tools, two tools
 * with one name, and more than SELECTION_TASKS_MAX tasks. A task that expects
 * a tool the server does not offer is skipped without a model call.
 *
 * The run asks up to SELECTION_CONCURRENCY tasks at once, and starts the next
 * task as each answer comes back. Every call gets the caller's signal.
 *
 * When the signal aborts, the run starts no new task and stops waiting for
 * the calls still out. It returns the tasks that finished, marks every other
 * task not_run, and sets stopped to deadline. The caller aborts the signal at
 * the run's deadline, so a slow model still returns the answers already billed.
 *
 * A failed model call marks its task error and stops the run from starting
 * more tasks. The calls already out finish, and the run returns what finished
 * with stopped set to model_failed. Only when no task got an answer does it
 * throw a SelectionRunError with code model_failed, because then it has
 * nothing to report.
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
  if (cases.length > SELECTION_TASKS_MAX) {
    throw new SelectionRunError(
      "too_many_tasks",
      `The run has ${cases.length} tasks, and one run asks at most ${SELECTION_TASKS_MAX}, because each task is a billed model call. Remove tasks from tests/selection.jsonl until it holds ${SELECTION_TASKS_MAX} or fewer.`,
    );
  }

  const tasks = cases.map((test, index) => ({ line: index + 1, task: test.task, expected: test.expect }));
  // A result for each task once it has one. A skipped task costs nothing, so
  // it gets its result before any model call and keeps it if the run stops.
  const results = tasks.map((task): SelectionCaseResult | undefined =>
    task.expected !== null && !offered.has(task.expected)
      ? {
          ...task,
          status: "skipped",
          reason: `The server does not offer ${task.expected}, so the run did not ask the model. Import the tool, or correct the task's expect.`,
        }
      : undefined,
  );
  const queue = tasks.filter((_, index) => results[index] === undefined);

  const aborted = signal === undefined ? null : whenAborted(signal);
  // Each failed call, in the order it failed. The first one stops the run.
  const failures: { line: number; error: unknown }[] = [];
  let next = 0;
  // Each worker takes the next task in file order until none is left, a call
  // has failed, or the signal has aborted.
  async function worker(): Promise<void> {
    while (failures.length === 0 && signal?.aborted !== true) {
      const task = queue[next];
      if (task === undefined) return;
      next += 1;
      const asked = await ask(model, { instructions: SELECTION_INSTRUCTIONS, task: task.task, tools }, signal, aborted);
      if (asked.kind === "answer") results[task.line - 1] = { ...task, ...judge(asked.reply, task.expected, offered) };
      if (asked.kind === "failed") {
        failures.push({ line: task.line, error: asked.error });
        results[task.line - 1] = { ...task, status: "error", reason: failureReason(asked.error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SELECTION_CONCURRENCY, queue.length) }, worker));

  const finished = results.filter((result): result is SelectionCaseResult => result !== undefined);
  // A task the model answered, well or badly. Each one is a billed call, so a
  // run with any of them returns them rather than throw them away.
  const answered = finished.filter((result) => result.status !== "skipped" && result.status !== "error");
  const failure = failures[0];
  if (failure !== undefined && answered.length === 0) {
    throw new SelectionRunError(
      "model_failed",
      `The model call for task ${failure.line} failed, and no task got an answer, so the run has no result to report.`,
      { line: failure.line, completed: finished, cause: failure.error },
    );
  }
  const report = tasks.map(
    (task, index): SelectionCaseResult => results[index] ?? { ...task, status: "not_run", reason: NOT_RUN_REASON },
  );
  const stopped: SelectionStop | null =
    failure !== undefined ? "model_failed" : finished.length < tasks.length ? "deadline" : null;
  return { cases: report, counts: countOutcomes(report), stopped };
}

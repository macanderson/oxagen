/**
 * step-grade.ts — whether each step of a run moved it forward (#3984,
 * ADR-199). PURE: the rollup (./cost-rollup.ts) grades a run from the frames
 * it already read, and the findings job (./findings.ts) shares the rule that
 * says one call repeats another.
 *
 * A step is one model call or one tool call. It is unproductive for one of
 * three recorded reasons, and each step counts under one reason at most:
 *
 * - `failed`: a tool call whose status is `error` or `rejected`.
 * - `repeated`: a tool call with the same tool, input digest and output
 *   digest as an earlier call of the run, which the findings job would file as
 *   waste: a shell command, or a call the classifier said reads without
 *   writing. A repeated call that writes may be doing new work, so it is not
 *   counted.
 * - `retried`: the session's API retries, at most one per model call. A retry
 *   is recorded as its own event, not as a model call, so the rollup charges
 *   one model-call step per retry, and never more than the run made.
 *
 * A step whose frame hides its outcome (an encrypted payload, no status, no
 * digests) is counted as advanced: the rollup does not call a step waste on
 * evidence it cannot read. Time spent waiting has no record and is not a
 * cause. `advanced` is `steps - unproductive` by construction, so the two
 * always sum to the run's steps, as `run_totals_steps_graded_check` requires.
 *
 * Each step also has a class (F17): `read_only` when none of its calls may
 * write and no file changed in it, and `edit` otherwise (`stepClassOf`,
 * `classifySteps`). Model class fit reprices the read-only steps.
 */
import type { StepCauses, ToolCallFrame } from "./cost-rollup";

/** The shell tool. The findings job files its identical repeats on their own. */
export const SHELL_TOOL = "Bash";

/**
 * How a repeated call is waste: a re-run shell command, or a read-only call
 * made again. Null for any other call, since a call that writes may change
 * what the next identical one returns.
 */
export function repeatKindOf(call: {
  tool: string;
  isMutating: boolean | null;
}): "shell" | "read" | null {
  if (call.tool === SHELL_TOOL) return "shell";
  if (call.isMutating === false) return "read";
  return null;
}

/**
 * The calls seen so far, in the order they ran. `repeats` answers whether a
 * call returned exactly what an earlier call with the same tool and input
 * returned, then remembers it. A call with no output digest repeats nothing
 * and is not remembered: an empty digest says the hook recorded no output,
 * not that the output was empty.
 */
export class RepeatedCalls {
  private readonly seen = new Map<string, Set<string>>();

  repeats(
    /** What the repeat is counted within: a run's public id, or "" inside one run. */
    scope: string,
    tool: string,
    inputDigest: string,
    outputDigest: string | null,
  ): boolean {
    if (outputDigest === null || outputDigest === "") return false;
    const key = `${scope}\u0000${tool}\u0000${inputDigest}`;
    const outputs = this.seen.get(key);
    if (outputs === undefined) {
      this.seen.set(key, new Set([outputDigest]));
      return false;
    }
    const repeated = outputs.has(outputDigest);
    outputs.add(outputDigest);
    return repeated;
  }
}

/**
 * Whether a step only read or also changed something (F17). Model class fit
 * (detector 4) reprices the steps that only read on a smaller model class.
 */
export type StepClass = "read_only" | "edit";

/** A run's steps by class. The two sum to the steps they count. */
export interface StepClasses {
  readOnly: number;
  edit: number;
}

/**
 * A step's class from the calls it made. A step is `read_only` when the
 * classifier marked every one of its calls as one that changes nothing and
 * no file changed in it. Any other step is an `edit`. A call the classifier
 * said nothing about may have written, so it makes the step an edit. A step
 * that made no call, such as a model call that answered in text, changed
 * nothing, so it reads as `read_only` unless a file changed in it.
 */
export function stepClassOf(step: {
  calls: readonly { isMutating: boolean | null }[];
  changedFile: boolean;
}): StepClass {
  if (step.changedFile) return "edit";
  return step.calls.every((c) => c.isMutating === false) ? "read_only" : "edit";
}

/**
 * One model call of a run and the tool calls it made, in the order they ran.
 * `modelCall` is false for the calls recorded before the run's first model
 * call, which no model call made.
 */
export interface StepRequest {
  modelCall: boolean;
  calls: readonly { isMutating: boolean | null }[];
}

/**
 * A model call's place in a run: its time in milliseconds and the chain it
 * was recorded on. `chain` is undefined when the store names no chain, and a
 * null chain is the run's own.
 */
export interface StepModelCall {
  atMs: number;
  chain?: string | null;
}

/** A tool call's place in a run, as {@link StepModelCall}, and the classifier's flag. */
export interface StepToolCall {
  /** Null when the store recorded no time for the call. */
  atMs: number | null;
  chain?: string | null;
  isMutating: boolean | null;
}

/** The last position in ascending `times` at or before `t`; -1 when none is. */
function lastAtOrBefore(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Each model call of a run with the tool calls it made, by the rule the
 * findings job uses (./findings/requests.ts): a tool call belongs to the
 * latest model call on its own chain at or before it, or to the run's latest
 * model call at or before it when its chain has none. A model call that names
 * no chain counts only toward the run's latest. A tool call with no time, or
 * one before every model call, goes in a request no model call made. The
 * requests come back with that one first, then one per model call in the
 * order given.
 */
export function stepRequestsOf(
  models: readonly StepModelCall[],
  tools: readonly StepToolCall[],
): StepRequest[] {
  // A model call with no readable time makes its own step and holds no call.
  const order = models
    .map((_, i) => i)
    .filter((i) => Number.isFinite(models[i]!.atMs))
    .sort((a, b) => models[a]!.atMs - models[b]!.atMs || a - b);
  const times = order.map((i) => models[i]!.atMs);
  const byChain = new Map<string, { times: number[]; index: number[] }>();
  for (const i of order) {
    const { chain, atMs } = models[i]!;
    if (chain === undefined) continue;
    const key = chain ?? "";
    const list = byChain.get(key) ?? { times: [], index: [] };
    list.times.push(atMs);
    list.index.push(i);
    byChain.set(key, list);
  }
  const made: StepToolCall[][] = models.map(() => []);
  const unmade: StepToolCall[] = [];
  for (const tool of tools) {
    let owner = -1;
    if (tool.atMs !== null && Number.isFinite(tool.atMs)) {
      const list =
        tool.chain === undefined ? undefined : byChain.get(tool.chain ?? "");
      if (list !== undefined) {
        const p = lastAtOrBefore(list.times, tool.atMs);
        if (p >= 0) owner = list.index[p]!;
      }
      if (owner < 0) {
        const p = lastAtOrBefore(times, tool.atMs);
        if (p >= 0) owner = order[p]!;
      }
    }
    (owner < 0 ? unmade : made[owner]!).push(tool);
  }
  const requests: StepRequest[] =
    unmade.length > 0 ? [{ modelCall: false, calls: unmade }] : [];
  for (const calls of made) requests.push({ modelCall: true, calls });
  return requests;
}

/**
 * Class every step of a run (ADR-199: one model call or one tool call). A
 * tool call is the only call of its own step. A model call's calls are the
 * tool calls it made.
 *
 * The record keeps file changes per run, not per step. A run's change is
 * placed on its steps that hold a call that may write, which are edits
 * already. When the run changed a file and no call may have written, no step
 * can hold the change, so the record cannot show any step only read, and
 * every step counts as an edit.
 */
export function classifySteps(args: {
  requests: readonly StepRequest[];
  changedFile: boolean;
}): StepClasses {
  let readOnly = 0;
  let edit = 0;
  const count = (cls: StepClass) => {
    if (cls === "read_only") readOnly += 1;
    else edit += 1;
  };
  const unplaced =
    args.changedFile &&
    args.requests.every((r) => r.calls.every((c) => c.isMutating === false));
  for (const request of args.requests) {
    if (request.modelCall)
      count(stepClassOf({ calls: request.calls, changedFile: unplaced }));
    for (const call of request.calls)
      count(stepClassOf({ calls: [call], changedFile: unplaced }));
  }
  return { readOnly, edit };
}

export interface StepGrade {
  advanced: number;
  unproductive: number;
  causes: StepCauses;
}

/**
 * Grade a run's steps from its recorded frames. `toolCalls` are in the order
 * they ran, and `retries` is the session's API retry count, null when the run
 * records none. Null for a run with no step, since a share of nothing is not
 * a ratio.
 */
export function gradeSteps(args: {
  modelCalls: number;
  toolCalls: readonly ToolCallFrame[];
  retries: number | null;
}): StepGrade | null {
  const steps = args.modelCalls + args.toolCalls.length;
  if (steps === 0) return null;
  const seen = new RepeatedCalls();
  let failed = 0;
  let repeated = 0;
  for (const call of args.toolCalls) {
    // Every call with an identity is remembered, whatever its own outcome,
    // so the call after it is judged against everything the run already did.
    const repeat =
      call.name !== null &&
      call.inputDigest !== null &&
      seen.repeats("", call.name, call.inputDigest, call.outputDigest);
    if (call.status === "error" || call.status === "rejected") {
      failed += 1;
      continue;
    }
    if (
      repeat &&
      call.name !== null &&
      repeatKindOf({ tool: call.name, isMutating: call.isMutating }) !== null
    )
      repeated += 1;
  }
  const retried = Math.min(
    Math.max(0, Math.trunc(args.retries ?? 0)),
    args.modelCalls,
  );
  const unproductive = failed + repeated + retried;
  return {
    advanced: steps - unproductive,
    unproductive,
    causes: { failed, repeated, retried },
  };
}

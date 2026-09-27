/**
 * requests.ts — each run's tool calls in time order, with each call's repeat
 * flag and the model request that made it (ADR-208). Spin loops, repeated
 * shell commands, duplicate tool calls, and unpaged results all read this one
 * view, so they agree on what a repeat is.
 *
 * A repeat is the rollup's rule (../step-grade.ts, ADR-199): the same tool,
 * input digest, and output digest as an earlier call of the run, on a shell
 * tool or a read-only one. A call that writes may change what the next
 * identical call returns, so it is never a repeat here.
 *
 * A tool call belongs to the latest model-call frame on its own chain at or
 * before the call, compared to the microsecond the store printed. The store
 * keeps milliseconds (`tacho_events.ts` is DateTime64(3)), so two chains can
 * finish a model call in one millisecond. The chain keeps their requests
 * apart. A call whose chain has no such frame takes the run's latest frame at
 * or before it: the proxy records a subagent's model call on the root chain
 * (ADR-168), so that call still lands by time alone (ADR-208 names the gap).
 */
import type { RunTotalsRecord } from "../cost-rollup";
import { RepeatedCalls, repeatKindOf } from "../step-grade";
import {
  timeOf,
  type CallFrame,
  type DetectInput,
  type PricedRequestFrame,
  type ToolCallObservation,
} from "./shared";

export type RepeatKind = "shell" | "read";

export interface ViewCall {
  call: ToolCallObservation;
  frame: CallFrame;
  /** The kind of repeat this call is; null when it is not a repeat a finding counts. */
  repeat: RepeatKind | null;
}

/** The tool calls one model request made. */
export interface RunRequest {
  /** Null for the calls made before the run's first frame read. */
  frame: PricedRequestFrame | null;
  calls: ViewCall[];
}

export interface RunView {
  run: RunTotalsRecord;
  /** Every call of the run, in time order. */
  calls: ViewCall[];
  /** The run's calls by the request that made them; null when its frames were not read. */
  requests: RunRequest[] | null;
}

function byTime(a: ToolCallObservation, b: ToolCallObservation): number {
  return timeOf(a) !== timeOf(b)
    ? timeOf(a) - timeOf(b)
    : a.runId !== b.runId
      ? a.runId < b.runId
        ? -1
        : 1
      : a.seq - b.seq;
}

/**
 * Each call with its repeat flag, in time order. A call with no input digest
 * is never a repeat: the hook recorded no input, so the call may have done
 * new work, and the request that made it does not count.
 */
function flagRepeats(calls: readonly ToolCallObservation[]): {
  call: ToolCallObservation;
  repeat: RepeatKind | null;
}[] {
  const seen = new RepeatedCalls();
  return [...calls].sort(byTime).map((call) => {
    const repeats =
      call.inputDigest !== "" &&
      seen.repeats(call.runId, call.tool, call.inputDigest, call.outputDigest);
    return { call, repeat: repeats ? repeatKindOf(call) : null };
  });
}

/**
 * Per run, how many of its calls are repeats a finding counts. The store
 * reads model-call frames for the runs with the most repeats first.
 */
export function runsWithRepeats(
  calls: readonly ToolCallObservation[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const { call, repeat } of flagRepeats(calls))
    if (repeat !== null) out.set(call.runId, (out.get(call.runId) ?? 0) + 1);
  return out;
}

/** The chain a call or a frame names, with the run's own chain as "". */
function chainOf(sessionUuid: string | null): string {
  return sessionUuid ?? "";
}

/**
 * The calls of one run, grouped by the latest frame on each call's chain at
 * or before it, or the run's latest frame at or before it when that chain has
 * none. Frames of one instant on two chains stay two requests.
 */
function attribute(
  calls: readonly ViewCall[],
  frames: readonly PricedRequestFrame[],
): RunRequest[] {
  const ordered = [...frames].sort((a, b) => timeOf(a) - timeOf(b));
  const requests: RunRequest[] = [];
  let before: RunRequest | null = null;
  const byFrame = new Map<PricedRequestFrame, RunRequest>();
  let latest: PricedRequestFrame | null = null;
  // The latest frame so far on each chain; a frame that names no chain
  // counts only toward `latest`.
  const onChain = new Map<string, PricedRequestFrame>();
  let i = 0;
  for (const c of calls) {
    const at = timeOf(c.call);
    for (; i < ordered.length && timeOf(ordered[i]!) <= at; i += 1) {
      const f = ordered[i]!;
      latest = f;
      if (f.sessionUuid !== undefined) onChain.set(chainOf(f.sessionUuid), f);
    }
    const frame = onChain.get(chainOf(c.call.sessionUuid)) ?? latest;
    if (frame === null) {
      if (before === null) {
        before = { frame: null, calls: [] };
        requests.push(before);
      }
      before.calls.push(c);
      continue;
    }
    let request = byFrame.get(frame);
    if (!request) {
      request = { frame, calls: [] };
      byFrame.set(frame, request);
      requests.push(request);
    }
    request.calls.push(c);
  }
  return requests;
}

/** One view per run with a tool call, in the order of each run's first call. */
export function buildRunViews(
  input: DetectInput,
  runs: ReadonlyMap<string, RunTotalsRecord>,
): RunView[] {
  const views = new Map<string, RunView>();
  const flagged = flagRepeats(input.toolCalls.filter((c) => runs.has(c.runId)));
  for (const { call, repeat } of flagged) {
    let view = views.get(call.runId);
    if (!view) {
      view = { run: runs.get(call.runId)!, calls: [], requests: null };
      views.set(call.runId, view);
    }
    view.calls.push({
      call,
      frame: { seq: call.seq, sessionUuid: call.sessionUuid },
      repeat,
    });
  }
  for (const view of views.values()) {
    const frames = input.frames?.get(view.run.runId);
    if (frames !== undefined) view.requests = attribute(view.calls, frames);
  }
  return [...views.values()];
}

/** Whether every tool call the request made is a repeat a finding counts. */
export function onlyRepeats(request: RunRequest): boolean {
  return (
    request.calls.length > 0 && request.calls.every((c) => c.repeat !== null)
  );
}

/** The key a claimed frame is held under within one pass. */
export function claimKey(runId: string, frameKey: string): string {
  return `${runId}\u0000${frameKey}`;
}

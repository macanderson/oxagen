/**
 * requests.ts — each run's tool calls in time order, with each call's repeat
 * flag and the model request that made it (ADR-206). Spin loops, repeated
 * shell commands, duplicate tool calls, and unpaged results all read this one
 * view, so they agree on what a repeat is.
 *
 * A repeat is the rollup's rule (../step-grade.ts, ADR-199): the same tool,
 * input digest, and output digest as an earlier call of the run, on a shell
 * tool or a read-only one. A call that writes may change what the next
 * identical call returns, so it is never a repeat here.
 *
 * A tool call belongs to the latest model-call frame of its run at or before
 * the call, compared to the microsecond the store printed. Frames carry no
 * chain, so a subagent's call can land on a parent's frame that ran just
 * before it (ADR-206 names the gap).
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

/** Each call with its repeat flag, in time order. */
function flagRepeats(calls: readonly ToolCallObservation[]): {
  call: ToolCallObservation;
  repeat: RepeatKind | null;
}[] {
  const seen = new RepeatedCalls();
  return [...calls].sort(byTime).map((call) => ({
    call,
    repeat: seen.repeats(
      call.runId,
      call.tool,
      call.inputDigest,
      call.outputDigest,
    )
      ? repeatKindOf(call)
      : null,
  }));
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

/** The calls of one run, grouped by the latest frame at or before each. */
function attribute(
  calls: readonly ViewCall[],
  frames: readonly PricedRequestFrame[],
): RunRequest[] {
  const ordered = [...frames].sort((a, b) => timeOf(a) - timeOf(b));
  const requests: RunRequest[] = [];
  let before: RunRequest | null = null;
  const byFrame = new Map<PricedRequestFrame, RunRequest>();
  let i = -1;
  for (const c of calls) {
    const at = timeOf(c.call);
    while (i + 1 < ordered.length && timeOf(ordered[i + 1]!) <= at) i += 1;
    if (i < 0) {
      if (before === null) {
        before = { frame: null, calls: [] };
        requests.push(before);
      }
      before.calls.push(c);
      continue;
    }
    const frame = ordered[i]!;
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

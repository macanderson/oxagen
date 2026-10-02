/**
 * requests.ts — each run's tool calls in time order, with each call's repeat
 * flag and the model request that made it (ADR-208). Spin loops, repeated
 * shell commands, duplicate tool calls, and unpaged results all read this one
 * view, so they agree on what a repeat is.
 *
 * A repeat is the rollup's rule (../step-grade.ts, ADR-199): the same tool,
 * input digest, and output digest as an earlier call of the run, on a shell
 * tool or a read-only one. A call that writes may change what the next
 * identical call returns, so it is never a repeat here. The store keeps
 * milliseconds (`tacho_events.ts` is DateTime64(3)), so two calls can share an
 * instant. Calls of one instant are judged against the calls before it and
 * never against each other: neither could have read the other's result
 * (#4506).
 *
 * A tool call belongs to the latest model-call frame on its own chain before
 * it, compared to the microsecond the store printed. A frame of the call's
 * own chain at the same instant comes before the call only when its `seq` is
 * lower: a chain numbers its model calls and tool calls from one counter, so
 * two requests of one chain in one millisecond stay two requests (#4506).
 * Frames of one instant on two chains stay two requests by their chains.
 *
 * The proxy records a subagent's model call on the root chain (ADR-168), so a
 * subagent can hold a frame on its own chain and make a later request on the
 * root chain. A subagent's call takes the root chain's latest frame when that
 * frame is later than its own chain's (#4506). A call whose chain has no frame
 * before it takes the run's latest frame before it, by time alone (ADR-208
 * names the gap).
 *
 * A model call that named no model starts a request that nothing prices
 * (`noModel`), so the calls after it do not join the priced request before it
 * (#4506).
 *
 * A cache keep-alive the proxy sent while the run waited on a subagent (lane
 * F32) made no tool call, so no call is placed under it. A hook seals a tool
 * call when the tool finishes, so the parent's call that started the subagent
 * finishes after the wait, and the subagent's own calls fall back to the run's
 * latest frame. Left in, the keep-alive took both.
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
  /**
   * Null for the calls made before the run's first frame read. A `noModel`
   * frame starts a request that nothing prices.
   */
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

/** What two calls of one run share when one would repeat the other. */
function sameCall(call: ToolCallObservation): string {
  return [call.runId, call.tool, call.inputDigest, call.outputDigest].join(
    "\u0000",
  );
}

/**
 * Each call with its repeat flag, in time order. A call with no input digest
 * is never a repeat: the hook recorded no input, so the call may have done
 * new work, and the request that made it does not count.
 *
 * The calls of one instant are judged against the calls before that instant
 * alone. The first of them with a given tool, input, and output asks the
 * history and adds to it. Another of the same instant takes that answer, so
 * it is never a repeat of its twin. One with another output asks the history
 * too: what a twin added under another output does not change its answer.
 */
function flagRepeats(calls: readonly ToolCallObservation[]): {
  call: ToolCallObservation;
  repeat: RepeatKind | null;
}[] {
  const seen = new RepeatedCalls();
  const sorted = [...calls].sort(byTime);
  const out: { call: ToolCallObservation; repeat: RepeatKind | null }[] = [];
  for (let i = 0; i < sorted.length; ) {
    const at = timeOf(sorted[i]!);
    const answered = new Map<string, boolean>();
    for (; i < sorted.length && timeOf(sorted[i]!) === at; i += 1) {
      const call = sorted[i]!;
      let repeats = false;
      if (call.inputDigest !== "") {
        const key = sameCall(call);
        const known = answered.get(key);
        repeats =
          known ??
          seen.repeats(
            call.runId,
            call.tool,
            call.inputDigest,
            call.outputDigest,
          );
        if (known === undefined) answered.set(key, repeats);
      }
      out.push({ call, repeat: repeats ? repeatKindOf(call) : null });
    }
  }
  return out;
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

/** The run's own chain, as {@link chainOf} names it. */
const ROOT_CHAIN = "";

/**
 * Whether `frame`, of the same instant as `call`, comes before it. Only a
 * frame of the call's own chain can come after it, when its `seq` is not
 * lower. A frame with no `seq` comes before it, as it did by time alone.
 */
function tiedFrameFirst(
  frame: PricedRequestFrame,
  call: ToolCallObservation,
): boolean {
  if (frame.sessionUuid === undefined || frame.seq === undefined) return true;
  if (chainOf(frame.sessionUuid) !== chainOf(call.sessionUuid)) return true;
  return frame.seq < call.seq;
}

/** The later of two frames of one chain and one instant: by `seq`, then by order. */
function laterOnChain(
  held: PricedRequestFrame | undefined,
  next: PricedRequestFrame,
): PricedRequestFrame {
  if (held === undefined || timeOf(held) !== timeOf(next)) return next;
  if (held.seq === undefined || next.seq === undefined) return next;
  return next.seq > held.seq ? next : held;
}

/**
 * The calls of one run, grouped by the request each belongs to: the latest
 * frame on its own chain before it, the root chain's latest frame when that
 * one is later and the call is a subagent's, or the run's latest frame before
 * it when its chain has none.
 */
function attribute(
  calls: readonly ViewCall[],
  frames: readonly PricedRequestFrame[],
): RunRequest[] {
  const ordered = frames
    .filter((f) => f.cacheKeepAlive !== true)
    .sort((a, b) => timeOf(a) - timeOf(b));
  const requests: RunRequest[] = [];
  let before: RunRequest | null = null;
  const byFrame = new Map<PricedRequestFrame, RunRequest>();
  // The latest frame before the current call's instant, and the latest on
  // each chain; a frame that names no chain counts only toward `latest`.
  let latest: PricedRequestFrame | null = null;
  const onChain = new Map<string, PricedRequestFrame>();
  let i = 0;
  for (const c of calls) {
    const at = timeOf(c.call);
    for (; i < ordered.length && timeOf(ordered[i]!) < at; i += 1) {
      const f = ordered[i]!;
      latest = f;
      if (f.sessionUuid !== undefined) {
        const chain = chainOf(f.sessionUuid);
        onChain.set(chain, laterOnChain(onChain.get(chain), f));
      }
    }
    const own = chainOf(c.call.sessionUuid);
    let run = latest;
    let ownFrame = onChain.get(own);
    let rootFrame = onChain.get(ROOT_CHAIN);
    // The frames of the call's own instant are read again for each call,
    // since one of its own chain may come after it.
    for (let j = i; j < ordered.length && timeOf(ordered[j]!) === at; j += 1) {
      const f = ordered[j]!;
      if (!tiedFrameFirst(f, c.call)) continue;
      run = f;
      if (f.sessionUuid === undefined) continue;
      const chain = chainOf(f.sessionUuid);
      if (chain === own) ownFrame = laterOnChain(ownFrame, f);
      if (chain === ROOT_CHAIN) rootFrame = laterOnChain(rootFrame, f);
    }
    const frame =
      ownFrame === undefined
        ? run
        : own !== ROOT_CHAIN &&
            rootFrame !== undefined &&
            timeOf(rootFrame) > timeOf(ownFrame)
          ? rootFrame
          : ownFrame;
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
    if (frames === undefined) continue;
    // A call that named no model bounds a request, and no detector reads it
    // as a frame (#4506).
    const bounds = input.modellessFrames?.get(view.run.runId) ?? [];
    view.requests = attribute(
      view.calls,
      bounds.length === 0 ? frames : [...frames, ...bounds],
    );
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

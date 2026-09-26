/**
 * The Run page's figures, read off the one step fold (ADR-182, amending
 * ADR-166's amendment of 2026-09-24).
 *
 * The page used to fold the frames again in the browser and count these
 * over its own fold (`features/run/metrics.ts`). They are counted here now,
 * over `stepFolds`, so the figures, the transcript and `get_run_turns` read
 * one set of steps.
 *
 * What is counted:
 *
 * - the model steps, the tool steps and the operator's prompts, a prompt
 *   counted as the transcript's `prompt` chip counts it;
 * - the tool calls: how many, how many failed or were refused, each tool's
 *   count, each family's figures, and the batches they ran in;
 * - where the recorded time went: model calls, tool calls, and people
 *   answering approvals.
 *
 * The run's wall clock is not here. It runs from the run's start to its end,
 * or on a live run to the instant it is read, and only the reader knows that
 * instant. The time none of these parts accounts for is the clock less their
 * sum, which the reader takes against its own clock.
 *
 * A call's own time is the fold's `durationMs`, less any approval wait that
 * fell inside it: the wait is the person's, not the tool's. A call with no
 * result has taken no time the record can state, so it adds none.
 */
import { type RunFrame } from "./run-frames";
import { bareToolName, type ToolFamily } from "./tool-family";
import type { TranscriptFold } from "./transcript-steps";

/** One family's share of the run's tool calls. */
export interface FamilyFigure {
  family: ToolFamily;
  calls: number;
  /** The family's calls over every tool call in the run. */
  share: number;
  /** The calls' own time summed, in milliseconds. */
  ms: number;
  failed: number;
  /** Distinct tool names in the family. */
  tools: number;
}

/**
 * The tool calls between two model steps. One model reply asks for them and
 * the next model call reads their results, so a batch is what the model
 * asked for at once.
 */
export interface BatchFigures {
  count: number;
  /** Batches that ran more than one call. */
  parallel: number;
  /** The most calls one batch held. */
  widest: number;
  /** Calls per batch. */
  fanOut: number;
  /** Every call's own time summed: what one at a time would have taken. */
  serialMs: number;
  /** Each batch's first start to its last end, summed: what it did take. */
  togetherMs: number;
  /** How many batches held each number of calls, fewest calls first. */
  histogram: { width: number; batches: number }[];
}

export interface TranscriptFigures {
  steps: { model: number; tool: number };
  /** The times the operator prompted the run, the first prompt included. */
  prompts: number;
  calls: {
    count: number;
    /** Calls that failed or that a rule, a person or the harness refused. */
    failed: number;
    /**
     * Calls per tool, by the tool's bare name (`bareToolName`), most called
     * first. `name` is null for calls whose record named no tool.
     */
    tools: { name: string | null; calls: number }[];
    /** Most called first; a tie reads in family-name order. */
    families: FamilyFigure[];
    /** Null for a run that called no tool. */
    batches: BatchFigures | null;
  };
  /** Where the recorded time went, in milliseconds. */
  wall: {
    /** Model steps, first frame to last. */
    modelMs: number;
    /** Tool calls' own time, less the approval waits inside them. */
    toolMs: number;
    /** From each approval request to the frame after it: people answering. */
    waitingMs: number;
  };
}

const APPROVAL_REQUEST = "approval_request";

/** One approval a person was asked for: when, and how long until the next frame. */
interface Wait {
  at: number;
  ms: number;
}

/**
 * Each approval request's wait: from the request to the frame after it,
 * which is the time a person held the run. A request with nothing recorded
 * after it has no wait yet.
 */
function waitsOf(frames: readonly RunFrame[]): Wait[] {
  const waits: Wait[] = [];
  for (let i = 0; i + 1 < frames.length; i += 1) {
    const frame = frames[i] as RunFrame;
    if (frame.type !== APPROVAL_REQUEST) continue;
    const at = frame.observedAt.getTime();
    const next = (frames[i + 1] as RunFrame).observedAt.getTime();
    waits.push({ at, ms: Math.max(0, next - at) });
  }
  return waits;
}

const startOf = (fold: TranscriptFold) => fold.opening.observedAt.getTime();
const endOf = (fold: TranscriptFold) => fold.last.observedAt.getTime();

/**
 * The waits, sorted by when each began, with a running sum, so the waits a
 * span holds are two binary searches rather than a pass over every wait.
 */
interface WaitIndex {
  at: number[];
  /** `sums[i]` is the waits before `at[i]` summed; one longer than `at`. */
  sums: number[];
}

function waitIndex(waits: readonly Wait[]): WaitIndex {
  const sorted = [...waits].sort((a, b) => a.at - b.at);
  const sums = [0];
  for (const wait of sorted)
    sums.push((sums[sums.length - 1] as number) + wait.ms);
  return { at: sorted.map((wait) => wait.at), sums };
}

/** The first index whose time is at or after `time`: a binary search. */
function lowerBound(times: readonly number[], time: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((times[mid] as number) < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The waits a step's span holds: those that began at or after its start and
 * before its end. A parked call's step runs from its request to its result,
 * so it holds the time a person took to answer. The wait is found by where
 * it falls, since the approval frame may be the call's own or a step of its
 * own.
 */
function waitIn(fold: TranscriptFold, waits: WaitIndex): number {
  const from = lowerBound(waits.at, startOf(fold));
  const to = lowerBound(waits.at, endOf(fold));
  if (to <= from) return 0;
  return (waits.sums[to] as number) - (waits.sums[from] as number);
}

interface Call {
  name: string | null;
  family: ToolFamily;
  /** Null when the call has no time of its own (see the top of this file). */
  ms: number | null;
  failed: boolean;
  batch: number;
  fold: TranscriptFold;
}

/**
 * The tool calls in step order, each with its batch. A model step closes the
 * batch, and so does a turn boundary: the next turn opens on a prompt.
 */
function callsOf(steps: readonly TranscriptFold[], waits: WaitIndex): Call[] {
  const calls: Call[] = [];
  let batch = -1;
  let open = false;
  let turn: number | null | undefined;
  for (const step of steps) {
    if (step.turn !== turn) {
      turn = step.turn;
      open = false;
    }
    if (step.node === "model") {
      open = false;
      continue;
    }
    if (step.node !== "tool") continue;
    if (!open) {
      batch += 1;
      open = true;
    }
    calls.push({
      name: step.subject === null ? null : bareToolName(step.subject),
      family: step.family ?? "tool",
      ms:
        step.durationMs === null
          ? null
          : Math.max(0, step.durationMs - waitIn(step, waits)),
      failed: step.outcome === "failed" || step.outcome === "denied",
      batch,
      fold: step,
    });
  }
  return calls;
}

function toolsOf(calls: readonly Call[]): TranscriptFigures["calls"]["tools"] {
  const by = new Map<string | null, number>();
  for (const call of calls) by.set(call.name, (by.get(call.name) ?? 0) + 1);
  return [...by.entries()]
    .map(([name, count]) => ({ name, calls: count }))
    .sort((a, b) => b.calls - a.calls || byName(a.name, b.name));
}

/** Names in code-unit order, with calls that named no tool last. */
function byName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareText(a, b);
}

/** Code-unit order, so a figure sorts the same on every server whatever its locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function familiesOf(calls: readonly Call[]): FamilyFigure[] {
  const by = new Map<
    ToolFamily,
    { calls: number; ms: number; failed: number; names: Set<string | null> }
  >();
  for (const call of calls) {
    const family = by.get(call.family) ?? {
      calls: 0,
      ms: 0,
      failed: 0,
      names: new Set<string | null>(),
    };
    family.calls += 1;
    family.ms += call.ms ?? 0;
    if (call.failed) family.failed += 1;
    family.names.add(call.name);
    by.set(call.family, family);
  }
  return [...by.entries()]
    .map(([family, figure]) => ({
      family,
      calls: figure.calls,
      share: figure.calls / calls.length,
      ms: figure.ms,
      failed: figure.failed,
      tools: figure.names.size,
    }))
    .sort((a, b) => b.calls - a.calls || compareText(a.family, b.family));
}

function batchesOf(calls: readonly Call[]): BatchFigures | null {
  if (calls.length === 0) return null;
  const groups = new Map<number, Call[]>();
  for (const call of calls) {
    const group = groups.get(call.batch) ?? [];
    group.push(call);
    groups.set(call.batch, group);
  }
  const histogram = new Map<number, number>();
  let togetherMs = 0;
  let widest = 0;
  let parallel = 0;
  for (const group of groups.values()) {
    widest = Math.max(widest, group.length);
    if (group.length > 1) parallel += 1;
    histogram.set(group.length, (histogram.get(group.length) ?? 0) + 1);
    // A call with no time of its own ends where it started.
    const start = Math.min(...group.map((call) => startOf(call.fold)));
    const end = Math.max(
      ...group.map((call) =>
        call.ms === null ? startOf(call.fold) : endOf(call.fold),
      ),
    );
    togetherMs += Math.max(0, end - start);
  }
  return {
    count: groups.size,
    parallel,
    widest,
    fanOut: calls.length / groups.size,
    serialMs: calls.reduce((sum, call) => sum + (call.ms ?? 0), 0),
    togetherMs,
    histogram: [...histogram.entries()]
      .sort(([a], [b]) => a - b)
      .map(([width, batches]) => ({ width, batches })),
  };
}

/**
 * The figures of a run, from its frames as read and their `steps` fold
 * (`stepFolds` over the same frames). The fold covers every chip, so the
 * figures do not move when a reader narrows the transcript.
 */
export function transcriptFigures(
  frames: readonly RunFrame[],
  steps: readonly TranscriptFold[],
): TranscriptFigures {
  const waits = waitsOf(frames);
  const calls = callsOf(steps, waitIndex(waits));
  let model = 0;
  let tool = 0;
  let prompts = 0;
  let modelMs = 0;
  for (const step of steps) {
    if (step.node === "model") {
      model += 1;
      modelMs += step.durationMs ?? 0;
    } else if (step.node === "tool") tool += 1;
    // A prompt counts as `counts.kinds.prompt` counts it: a prompt the
    // reader is shown, so one of only whitespace is not a time the operator
    // prompted the run.
    if (!step.quiet && step.kinds.has("prompt")) prompts += 1;
  }
  return {
    steps: { model, tool },
    prompts,
    calls: {
      count: calls.length,
      failed: calls.filter((call) => call.failed).length,
      tools: toolsOf(calls),
      families: familiesOf(calls),
      batches: batchesOf(calls),
    },
    wall: {
      modelMs,
      toolMs: calls.reduce((sum, call) => sum + (call.ms ?? 0), 0),
      waitingMs: waits.reduce((sum, wait) => sum + wait.ms, 0),
    },
  };
}

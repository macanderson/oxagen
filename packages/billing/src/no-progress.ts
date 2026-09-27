/**
 * no-progress.ts — the no-progress limit (spend spec, detector 1). PURE: the
 * store (./no-progress-store.ts) reads the limit and the run's tool calls,
 * and records what this module finds.
 *
 * The owning team sets the limit as a count, such as "pause after 20
 * unchanged repeats", and a mode. A loop is the same call made again and
 * again in a row: the same tool, input digest, and output digest each time.
 * It hits the limit when the calls in it, the first one included, reach the
 * count, so 20 identical calls in a row meet a limit of 20.
 *
 * A call counts only when `RepeatedCalls` in ./step-grade.ts would count it
 * as a repeat: a shell command or a read-only call, with an output digest.
 * Any other call ends the loop, and so does a file change the harness
 * announced between two calls. That covers the spec's "no mutating call or
 * file change between them": a call that writes, one the classifier said
 * nothing about, or a file changed outside any call may change what the
 * next call returns.
 *
 * Observe mode records each hit and lets the run continue. Enforced mode
 * pauses the run at the next checkpoint, on governed calls, when the check
 * can reach the pause path, and records `would_pause` when it cannot.
 * No count means no check: the limit ships without a default.
 */
import type { ToolCallFrame } from "./cost-rollup";
import { RepeatedCalls, repeatKindOf } from "./step-grade";

export const NO_PROGRESS_MODES = ["observe", "enforced"] as const;
export type NoProgressMode = (typeof NO_PROGRESS_MODES)[number];

export const NO_PROGRESS_OUTCOMES = ["would_pause", "paused"] as const;
export type NoProgressOutcome = (typeof NO_PROGRESS_OUTCOMES)[number];

/** The smallest count a limit can name: one call and one repeat of it. */
export const NO_PROGRESS_MIN_REPEATS = 2;

/** What the check reads of one tool call. A rollup `ToolCallFrame` is one. */
export type NoProgressCall = Pick<
  ToolCallFrame,
  "name" | "inputDigest" | "outputDigest" | "isMutating"
>;

/**
 * One step of a run in the order it ran: a tool call, or a file change the
 * harness announced between calls. A file change ends any loop.
 */
export type NoProgressFrame = NoProgressCall | { fileChanged: true };

/** A workspace's no-progress limit. */
export interface NoProgressLimit {
  /** The calls in a row that make a hit, the first one included. */
  repeats: number;
  mode: NoProgressMode;
}

/** One loop that reached the limit. */
export interface NoProgressLoop {
  tool: string;
  inputDigest: string;
  outputDigest: string;
  /** 1 for the call's first loop in the run, 2 for its second, and so on. */
  loop: number;
  /** The calls in the loop so far, the first one included. */
  repeats: number;
  /** The call that reached the limit, counted from 1 in the run's call order. */
  atCall: number;
}

/**
 * The limit a stored row states, or null when it states none. A row with no
 * count, or a count below {@link NO_PROGRESS_MIN_REPEATS}, runs no check. An
 * unknown mode reads as observe, the mode that never pauses.
 */
export function noProgressLimitOf(
  row: { repeats: number | null; mode: string } | null | undefined,
): NoProgressLimit | null {
  if (!row || row.repeats === null) return null;
  if (!Number.isInteger(row.repeats) || row.repeats < NO_PROGRESS_MIN_REPEATS)
    return null;
  return {
    repeats: row.repeats,
    mode: row.mode === "enforced" ? "enforced" : "observe",
  };
}

/** What a hit records: `paused` only when an enforced limit paused the run. */
export function noProgressOutcome(
  mode: NoProgressMode,
  paused: boolean,
): NoProgressOutcome {
  return mode === "enforced" && paused ? "paused" : "would_pause";
}

interface CallIdentity {
  tool: string;
  inputDigest: string;
  outputDigest: string;
}

/** The call's identity, or null when it cannot be part of a loop. */
function identityOf(call: NoProgressCall): CallIdentity | null {
  const { name, inputDigest, outputDigest, isMutating } = call;
  if (!name || !inputDigest || !outputDigest) return null;
  if (repeatKindOf({ tool: name, isMutating }) === null) return null;
  return { tool: name, inputDigest, outputDigest };
}

/** The loop being counted: its call, its length, and its hit once it has one. */
interface Streak {
  key: string;
  count: number;
  loop: NoProgressLoop | null;
}

function keyOf(call: CallIdentity): string {
  return `${call.tool}\u0000${call.inputDigest}\u0000${call.outputDigest}`;
}

/**
 * Every loop in the run's frames that reached `limit`, in the order each one
 * reached it. A loop reports once, with the count it has reached so far, so
 * a check that reads the run again as it grows finds the same loops again.
 * `atCall` counts tool calls only, never file changes.
 */
export function findNoProgressLoops(
  frames: readonly NoProgressFrame[],
  limit: number,
): NoProgressLoop[] {
  if (!Number.isInteger(limit) || limit < NO_PROGRESS_MIN_REPEATS) return [];
  const seen = new RepeatedCalls();
  const loopsPerCall = new Map<string, number>();
  const loops: NoProgressLoop[] = [];
  let streak: Streak | null = null;
  let calls = 0;

  for (const frame of frames) {
    if ("fileChanged" in frame) {
      streak = null;
      continue;
    }
    calls += 1;
    const identity = identityOf(frame);
    if (identity === null) {
      streak = null;
      continue;
    }
    const key = keyOf(identity);
    const repeated = seen.repeats(
      "",
      identity.tool,
      identity.inputDigest,
      identity.outputDigest,
    );
    if (repeated && streak !== null && streak.key === key) {
      streak.count += 1;
    } else {
      streak = { key, count: 1, loop: null };
    }
    if (streak.loop !== null) {
      streak.loop.repeats = streak.count;
      continue;
    }
    if (streak.count < limit) continue;
    const ordinal = (loopsPerCall.get(key) ?? 0) + 1;
    loopsPerCall.set(key, ordinal);
    streak.loop = {
      ...identity,
      loop: ordinal,
      repeats: streak.count,
      atCall: calls,
    };
    loops.push(streak.loop);
  }
  return loops;
}

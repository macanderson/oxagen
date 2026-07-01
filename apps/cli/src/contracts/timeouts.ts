/**
 * Timeout-policy contract (pipeline Group 8 bug fix — not yet built).
 *
 * The bug: the CLI ends a turn after a fixed wall-clock limit of a few hundred
 * seconds. A single turn can make hundreds of model calls, so a turn-level
 * wall-clock cap is wrong. Timeouts belong on the model call. A turn should keep
 * running as long as it keeps making progress.
 *
 * Fresh, standalone stub — Group 8 has not landed in this worktree. Matches the
 * original `contracts/timeouts.ts` stub as-is (no shipped code to reconcile
 * against yet); `DEFAULT_TIMEOUTS` is the one real value the whole `contracts/`
 * surface ships, and is exercised directly by `__tests__/contracts.test.ts`.
 */
export interface TimeoutConfig {
  // Applied to each individual model call. This is the real timeout.
  perModelCallMs: number; // e.g. 120000

  // Optional per-tool-call timeout (graph query, judge, monitor dispatch, etc.).
  perToolCallMs?: number; // e.g. 120000

  // Optional progress guard. NOT a wall-clock cap. It aborts the turn only if no
  // model call or tool call completes within this window. Any completed call
  // resets it. Leave undefined to disable.
  turnInactivityMs?: number; // e.g. 300000 of NO progress, not total time

  // Hard ceiling as a last-resort safety net. Disabled by default. If set, it
  // should be very large. Never set this to a few hundred seconds.
  turnHardCeilingMs?: number; // default: undefined (off)

  // Retry policy for a timed-out model call.
  retry: {
    maxRetries: number; // e.g. 2
    backoffMs: number; // e.g. 1000
  };
}

export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  perModelCallMs: 120000,
  perToolCallMs: 120000,
  turnInactivityMs: 300000, // resets on every completed call; not total turn time
  turnHardCeilingMs: undefined,
  retry: { maxRetries: 2, backoffMs: 1000 },
};

// A single model call carries its own deadline. The turn does not impose one.
export interface ModelCall {
  id: string;
  model: string;
  timeoutMs: number; // defaults to TimeoutConfig.perModelCallMs
  startedAt: number;
}

export interface ProgressEvent {
  kind: "model_call_done" | "tool_call_done";
  callId: string;
  at: number;
}

// The turn runner watches progress, not wall-clock. Implement so that:
//  - each ModelCall is raced against its own timeoutMs
//  - a completed ModelCall or tool call emits a ProgressEvent
//  - the inactivity guard (if set) resets on every ProgressEvent
//  - the turn only aborts on inactivity or the optional hard ceiling
export interface TurnRunner {
  onProgress(ev: ProgressEvent): void;
  // Returns the reason the turn ended: "completed" | "inactivity" | "hard_ceiling".
  run(work: () => Promise<void>): Promise<"completed" | "inactivity" | "hard_ceiling">;
}

/**
 * Idle-poll backoff math for the claim loop — pure, no I/O, so the exponential
 * curve and jitter are unit-testable without timers (docs/specs/agent-engine-v2
 * Phase 2c).
 */

export interface BackoffOptions {
  /** Base delay in ms (WorkerOptions.pollIntervalMs). */
  baseMs: number;
  /** Upper bound in ms regardless of attempt count (~15s default). */
  capMs: number;
  /** Source of randomness in [0, 1). Defaults to Math.random; injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Full-jitter exponential backoff (the AWS architecture-blog formula): a
 * uniformly random delay in `[0, min(capMs, baseMs * 2^attempt))`. `attempt`
 * counts consecutive empty claims since the last successful one — the claim
 * loop resets it to 0 on every successful `claimNextRun`, so a busy queue
 * never over-backs-off and an idle one backs off smoothly up to the cap.
 */
export function computeBackoffDelayMs(
  attempt: number,
  opts: BackoffOptions,
): number {
  const random = opts.random ?? Math.random;
  const uncapped = opts.baseMs * 2 ** Math.max(0, attempt);
  const bound = Number.isFinite(uncapped)
    ? Math.min(opts.capMs, uncapped)
    : opts.capMs;
  return Math.floor(random() * bound);
}

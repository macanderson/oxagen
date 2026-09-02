/**
 * Health-status + backoff math for the generic connector poll/sync loop.
 *
 * These are PURE functions — no DB, no clock, no randomness unless injected —
 * so the scheduling and self-healing behaviour of the sync loop is unit-testable
 * without a running Inngest/Postgres. The connection-poll Inngest function calls
 * them to decide the next `health_status`, `next_poll_at`, and whether to keep
 * retrying.
 *
 * Health model (persisted to ingestion.source_connections.health_status):
 *   healthy   — last poll succeeded (consecutive_failure_count === 0)
 *   degraded  — 1..(ERRORED_AFTER_FAILURES-1) consecutive poll failures; still
 *               polling on a backed-off schedule, data may be stale
 *   errored   — ERRORED_AFTER_FAILURES+ consecutive failures; surfaced in the UI
 *               as "needs attention". The loop keeps retrying (capped backoff),
 *               but an operator/reconnect is likely required.
 */

export type ConnectionHealthStatus = "healthy" | "degraded" | "errored";

/** First failure already downgrades health to `degraded`. */
export const DEGRADED_AFTER_FAILURES = 1;
/** Nth consecutive failure escalates health to `errored`. */
export const ERRORED_AFTER_FAILURES = 4;

/** Backoff floor — the delay after a single failure (before jitter). */
export const BASE_BACKOFF_MS = 60_000; // 1 minute
/** Backoff ceiling — exponential growth is clamped here. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Map a consecutive-failure count to a health status.
 * 0 → healthy, 1..3 → degraded, 4+ → errored (with the defaults above).
 */
export function healthForFailureCount(
  consecutiveFailures: number,
): ConnectionHealthStatus {
  if (consecutiveFailures <= 0) return "healthy";
  if (consecutiveFailures >= ERRORED_AFTER_FAILURES) return "errored";
  return "degraded";
}

/**
 * Exponential backoff with full jitter, clamped to [BASE, MAX].
 *
 * delay = clamp(BASE * 2^(n-1), BASE, MAX) then randomized in [50%, 100%] of
 * that value ("full jitter"–style) to avoid a thundering herd of connections
 * all retrying on the same tick. `random` is injectable for deterministic tests.
 */
export function backoffMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  // 2^(n-1) can overflow to Infinity for large n; Math.min collapses that to MAX.
  const raw = BASE_BACKOFF_MS * 2 ** (n - 1);
  const capped = Math.min(raw, MAX_BACKOFF_MS);
  const jittered = capped * (0.5 + 0.5 * random());
  return Math.floor(jittered);
}

/**
 * Compute when a connection should next be polled.
 *   success (0 failures) → now + the connector's steady-state poll interval
 *   failure (>0)         → now + jittered exponential backoff
 */
export function nextPollAt(args: {
  now: Date;
  intervalSeconds: number;
  consecutiveFailures: number;
  random?: () => number;
}): Date {
  const { now, intervalSeconds, consecutiveFailures, random } = args;
  const delayMs =
    consecutiveFailures <= 0
      ? Math.max(1, Math.floor(intervalSeconds)) * 1000
      : backoffMs(consecutiveFailures, random);
  return new Date(now.getTime() + delayMs);
}

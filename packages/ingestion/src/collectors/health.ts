// collectors/health.ts: a collector's health, from its recent reconciles and
// its last nightly count (agent-work-spec.html, Collectors).
//
// - healthy: the last reconcile missed nothing and the last count matched.
// - lagging: a reconcile found items the doorbell missed, or the count
//   differed. Oxagen keeps reconciling.
// - failing: three reconciles in a row could not authenticate or fetch.
//   Oxagen stops polling until an admin reconnects.
// - paused: a person paused it. Only a person moves it out of paused.

export const COLLECTOR_HEALTH_VALUES = [
  "healthy",
  "lagging",
  "failing",
  "paused",
] as const;

export type CollectorHealth = (typeof COLLECTOR_HEALTH_VALUES)[number];

/** Failed reconciles in a row that make a collector failing. */
export const FAILING_AFTER_FAILED_RECONCILES = 3;

/** What the recent results say. */
export interface HealthSignals {
  /** Failed reconciles since the last one that finished. */
  failedStreak: number;
  /** Items the last finished reconcile found the doorbell had missed. */
  lastReconcileMissed: number;
  /** True when the last nightly count differed. False when none has run. */
  lastCountDiffered: boolean;
}

/** The health the signals give. A paused collector stays paused. */
export function healthOf(
  current: CollectorHealth,
  signals: HealthSignals,
): CollectorHealth {
  if (current === "paused") return "paused";
  if (signals.failedStreak >= FAILING_AFTER_FAILED_RECONCILES) return "failing";
  if (signals.lastReconcileMissed > 0 || signals.lastCountDiffered)
    return "lagging";
  return "healthy";
}

/** True when a health value is one work.collectors accepts. */
export function isCollectorHealth(value: unknown): value is CollectorHealth {
  return (
    typeof value === "string" &&
    (COLLECTOR_HEALTH_VALUES as readonly string[]).includes(value)
  );
}

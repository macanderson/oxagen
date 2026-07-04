/**
 * breaker-clients.ts — the shared, pre-configured circuit breakers for the two
 * external dependencies whose trips CAN be recorded in ClickHouse: Neo4j and
 * Stripe. (The ClickHouse breaker itself lives in `clickhouse.ts` because it
 * cannot write its own trips to the store that is down — it logs to stderr.)
 *
 * A breaker open/close transition is emitted as an append-only row in the
 * generic `events` table so a degraded dependency is observable in analytics.
 * These are infra-level, not tenant-level, events, so org/workspace are the nil
 * UUID sentinel (the established "no tenant scope" pattern) and source_system is
 * "circuit-breaker".
 *
 * Consumers:
 *   - `@oxagen/ontology` wraps its scoped Neo4j `run()` with `neo4jBreaker()`.
 *   - `@oxagen/billing` wraps its Stripe SDK calls with `stripeBreaker()`.
 */
import {
  getBreaker,
  type BreakerTransition,
  type CircuitBreaker,
} from "./circuit-breaker";
import { breakerEnvConfig } from "./breaker-config";
import { insertEvents, NIL_UUID, type EventRow } from "./clickhouse";

/**
 * Record a breaker transition in ClickHouse. Best-effort and fully guarded — a
 * telemetry failure must never propagate back into the breaker (it is invoked
 * from the breaker's `onTransition`, which already swallows throws, but we also
 * fire-and-forget here so a slow insert never blocks the call path).
 */
function emitTransitionToClickHouse(t: BreakerTransition): void {
  const row: EventRow = {
    event_id: crypto.randomUUID(),
    org_id: NIL_UUID,
    workspace_id: NIL_UUID,
    // `circuit_breaker.open` | `circuit_breaker.half-open` | `circuit_breaker.closed`
    event_type: `circuit_breaker.${t.to}`,
    source_system: "circuit-breaker",
    stream_offset: null,
    payload: JSON.stringify({
      key: t.key,
      from: t.from,
      to: t.to,
      failureCount: t.failureCount,
      error: t.error,
    }),
    emitted_at: new Date(t.at).toISOString(),
  };
  // Fire-and-forget: never await inside a breaker transition.
  void insertEvents([row]).catch(() => {
    // If ClickHouse is ALSO down we simply lose this breaker event — stderr is
    // the floor so the trip is still visible in process logs.
    process.stderr.write(
      `[circuit-breaker] ${t.key} ${t.from}->${t.to} (failures=${t.failureCount})` +
        (t.error ? ` err=${t.error}` : "") +
        " [clickhouse emit failed]\n",
    );
  });
}

/** Log every transition to stderr AND record it in ClickHouse. */
function onTransition(t: BreakerTransition): void {
  process.stderr.write(
    `[circuit-breaker] ${t.key} ${t.from}->${t.to} (failures=${t.failureCount})` +
      (t.error ? ` err=${t.error}` : "") +
      "\n",
  );
  emitTransitionToClickHouse(t);
}

/** Process-wide breaker guarding the shared Neo4j driver's scoped queries. */
export function neo4jBreaker(): CircuitBreaker {
  return getBreaker("neo4j", { ...breakerEnvConfig(), onTransition });
}

/** Process-wide breaker guarding the shared Stripe client's network calls. */
export function stripeBreaker(): CircuitBreaker {
  return getBreaker("stripe", { ...breakerEnvConfig(), onTransition });
}

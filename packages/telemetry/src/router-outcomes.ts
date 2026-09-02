import { chInsert, chSelect } from "./tenant";

// Tenant-scoped observed outcomes of the Verified-Outcome Market Router. Written
// by a server-side caller of the agent engine (via the onRouteOutcome hook →
// recordRouterOutcome) and read back by readRoutingStats to compute each task
// class's live cost/accuracy Pareto curve. org_id/workspace_id are stamped by
// chInsert from the active tenant scope — callers MUST NOT pass them — and
// chSelect enforces the org_id filter on read (fail-closed), so one workspace can
// never read another's routing history. Mirrors eval-item-results.ts.
//
// This module deals in STRINGS and numbers only; it never imports
// @oxagen/agent-engine (the engine has no telemetry dependency, and vice versa).
// RoutingStatRow is structurally identical to the engine's RoutingStatRow, so a
// handler that imports both can pass a stats snapshot straight into
// decideMarketRoute.

/**
 * One append-only outcome row (mirrors the router_outcomes DDL). The tenant
 * columns are omitted — chInsert stamps them from the active scope.
 */
export interface RouterOutcomeRow {
  /** Turn/execution (trace) id the outcome belongs to. */
  execution_id: string;
  /** Stable task class from deriveTaskClass, e.g. "auth/single". */
  task_class: string;
  /** SHA-256 (hex) of the refined prompt — dedup / drift signal, PII-free. */
  signature_hash: string;
  /** The model that actually served the round. */
  model: string;
  /** The tier it counted as ("fast" | "balanced" | "precise"). */
  tier: string;
  /** 1 when the outcome was a verified success, else 0. */
  verified: 0 | 1;
  /** What proved it: 'tests' | 'judge' | 'eval' | 'completion'. */
  verification_source: string;
  /** Confidence / eval score in [0,1]. */
  score: number;
  /** Observed provider cost for the round, in micro-USD. */
  cost_usd_micros: number;
  /** Observed wall-clock latency, in ms. */
  latency_ms: number;
  /** Driving surface: 'app' | 'cli' | 'api' | 'mcp' | ''. */
  surface: string;
  /** Routing mode in force: 'static' | 'shadow' | 'enforce'. */
  routing_mode: string;
}

/**
 * Record one router outcome. Fire-and-forget from the engine's perspective (the
 * caller wraps this so a telemetry failure never wedges a turn). The active
 * tenant scope stamps org_id/workspace_id (chInsert), so the caller must run this
 * inside runInTenantScope({ orgId, workspaceId }, …).
 */
export async function recordRouterOutcome(
  row: RouterOutcomeRow,
): Promise<void> {
  await chInsert("router_outcomes", [
    row as unknown as Record<string, unknown>,
  ]);
}

/** One (task_class, model) aggregate — the Pareto-curve row. Structurally matches the engine's RoutingStatRow. */
export interface RoutingStatRow {
  taskClass: string;
  model: string;
  tier: string;
  samples: number;
  verifiedCount: number;
  verifiedRate: number;
  avgCostUsdMicros: number;
  avgLatencyMs: number;
  lastSeen: string;
}

/** Raw JSONEachRow shape: ClickHouse serializes UInt64 aggregates as decimal strings. */
interface RawRoutingStat {
  task_class: string;
  model: string;
  tier: string;
  samples: string;
  verified_count: string;
  verified_rate: number;
  avg_cost_usd_micros: number;
  avg_latency_ms: number;
  last_seen: string;
}

export interface ReadRoutingStatsArgs {
  /** Restrict to a single task class; omit for every class. */
  taskClass?: string;
  /** Trailing window in days (outcomes newer than now() - windowDays). */
  windowDays: number;
  /** Drop (task_class, model) groups with fewer than this many samples. */
  minSamples: number;
}

/**
 * Read the per-(task_class, model) outcome aggregates for the active tenant over
 * a trailing window — the router's Pareto-curve read. GROUP BY (task_class,
 * model); a group is kept only when it has `>= minSamples` samples. Ordered by
 * task class then cheapest-first so the cheapest proven venue leads each class.
 *
 * Tenant-filtered by the active scope via chSelect (throws if unscoped). The
 * aggregate projection mirrors readUsageBreakdown's conventions (mandatory
 * org_id filter, Number()-coerced UInt64 aggregates).
 */
export async function readRoutingStats(
  args: ReadRoutingStatsArgs,
): Promise<RoutingStatRow[]> {
  const taskClassFilter = args.taskClass
    ? "AND task_class = {taskClass:String}"
    : "";
  const params: Record<string, unknown> = {
    windowDays: Math.max(0, Math.floor(args.windowDays)),
    minSamples: Math.max(0, Math.floor(args.minSamples)),
  };
  if (args.taskClass) params.taskClass = args.taskClass;

  const res = await chSelect<RawRoutingStat>({
    query: `
      SELECT
        task_class                    AS task_class,
        model                         AS model,
        any(tier)                     AS tier,
        count()                       AS samples,
        sum(verified)                 AS verified_count,
        avg(verified)                 AS verified_rate,
        avg(cost_usd_micros)          AS avg_cost_usd_micros,
        avg(latency_ms)               AS avg_latency_ms,
        toString(max(created_at))     AS last_seen
      FROM router_outcomes
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND created_at >= now() - toIntervalDay({windowDays:UInt32})
        ${taskClassFilter}
      GROUP BY task_class, model
      HAVING samples >= {minSamples:UInt32}
      ORDER BY task_class ASC, avg_cost_usd_micros ASC
    `,
    params,
  });

  return res.data.map((r) => ({
    taskClass: r.task_class,
    model: r.model,
    tier: r.tier,
    samples: Number(r.samples),
    verifiedCount: Number(r.verified_count),
    verifiedRate: Number(r.verified_rate),
    avgCostUsdMicros: Number(r.avg_cost_usd_micros),
    avgLatencyMs: Number(r.avg_latency_ms),
    lastSeen: r.last_seen,
  }));
}

// error-clusters.ts
//
// Tenant-scoped, bounded read over ClickHouse `error_events` that clusters
// captured errors by `fingerprint` — a stable grouping key (SHA-256 of
// error_class + normalized message) already computed at capture time
// (see migration 0020_error_events.sql). This feeds `telemetry.error.cluster`,
// the fleet-wide "what error classes are burning" triage overview — the
// counterpart to `agent.debug.trace`'s single-execution failure frame.
//
// ADR-021 §1/§3: pure, parameterized SQL — zero model calls, and every list
// this returns is LIMIT-bounded before it reaches a caller/model.
//
// A mocked ClickHouse client accepts invalid SQL without complaint, so an
// aggregate query that passes unit tests can still fail in production
// (error 184 — "column X is not under aggregate function and not in GROUP
// BY"). GROUP BY here stays `fingerprint` ONLY; every other selected column
// goes through an aggregate (count(), argMax(), min(), max()) — never a bare
// column alias in GROUP BY.

import { clickhouse } from "./clickhouse";

/** Hard ceiling on clusters returned — bounds the model/operator payload. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_SINCE_HOURS = 24;

export type ErrorClusterSeverity = "fatal" | "error" | "warn";

/** One clustered error class within the window, coerced to typed fields. */
export interface ErrorCluster {
  fingerprint: string;
  errorClass: string;
  sampleMessage: string;
  severity: ErrorClusterSeverity;
  source: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ClusterErrorEventsResult {
  clusters: ErrorCluster[];
  /** Total error occurrences in the window, across every fingerprint. */
  totalErrors: number;
  /** Total distinct fingerprints in the window (may exceed clusters.length). */
  distinctClusters: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/** ClickHouse DateTime64 params want a space-separated, Z-less string. */
function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Cluster the `error_events` captured for an org within a lookback window,
 * grouped by `fingerprint`. Bounded by `limit` (≤ 100 clusters, ranked by
 * occurrence count) and a time window (`sinceMs`, an absolute epoch-ms floor
 * on `created_at`). Optionally narrowed to one `severity` and/or `source`.
 *
 * `totalErrors`/`distinctClusters` reflect the WHOLE filtered window (not just
 * the returned page), via a second bounded aggregate query with no GROUP BY,
 * so callers can tell whether the returned clusters were truncated.
 */
export async function clusterErrorEvents(args: {
  orgId: string;
  /** Absolute epoch-ms floor on created_at. Defaults to now − 24h. */
  sinceMs?: number;
  severity?: ErrorClusterSeverity;
  source?: string;
  limit?: number;
}): Promise<ClusterErrorEventsResult> {
  const limit = clampLimit(args.limit);
  const since =
    args.sinceMs ?? Date.now() - DEFAULT_SINCE_HOURS * 60 * 60 * 1000;

  const filters: string[] = [
    "org_id = {orgId:UUID}",
    "created_at >= {since:DateTime64(3)}",
  ];
  const params: Record<string, unknown> = {
    orgId: args.orgId,
    since: chDateTime(since),
  };
  if (args.severity) {
    filters.push("severity = {severity:String}");
    params.severity = args.severity;
  }
  if (args.source) {
    filters.push("source = {source:String}");
    params.source = args.source;
  }
  const whereClause = filters.join("\n        AND ");

  const [clusterResult, totalsResult] = await Promise.all([
    clickhouse().query({
      query: `
      SELECT
        fingerprint,
        argMax(error_class, created_at) AS error_class,
        argMax(message, created_at) AS sample_message,
        argMax(severity, created_at) AS severity,
        argMax(source, created_at) AS source,
        count() AS count,
        min(created_at) AS first_seen,
        max(created_at) AS last_seen
      FROM error_events
      WHERE ${whereClause}
      GROUP BY fingerprint
      ORDER BY count DESC
      LIMIT {limit:UInt32}
    `,
      query_params: { ...params, limit },
      format: "JSONEachRow",
    }),
    clickhouse().query({
      query: `
      SELECT
        count() AS total_errors,
        uniqExact(fingerprint) AS distinct_clusters
      FROM error_events
      WHERE ${whereClause}
    `,
      query_params: params,
      format: "JSONEachRow",
    }),
  ]);

  interface RawCluster {
    fingerprint: string;
    error_class: string;
    sample_message: string;
    severity: ErrorClusterSeverity;
    source: string;
    count: string | number;
    first_seen: string;
    last_seen: string;
  }
  interface RawTotals {
    total_errors: string | number;
    distinct_clusters: string | number;
  }

  const rows = (await clusterResult.json()) as RawCluster[];
  const totalsRows = (await totalsResult.json()) as RawTotals[];
  const totals = totalsRows[0];

  return {
    clusters: rows.map((r) => ({
      fingerprint: r.fingerprint,
      errorClass: r.error_class,
      sampleMessage: r.sample_message,
      severity: r.severity,
      source: r.source,
      count: Number(r.count),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    })),
    totalErrors: totals ? Number(totals.total_errors) : 0,
    distinctClusters: totals ? Number(totals.distinct_clusters) : 0,
  };
}

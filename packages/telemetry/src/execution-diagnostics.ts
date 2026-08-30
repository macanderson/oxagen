// execution-diagnostics.ts
//
// Tenant-scoped, bounded reads over the two ClickHouse runtime-event tables an
// agent-run failure post-mortem needs: `error_events` (captured errors, keyed
// by execution_id since migration 0022) and `execution_logs` (structured log
// lines, keyed by execution_id in the sort key). These feed the deterministic
// compressor behind `agent.debug.trace` (debug_with_trace) — ADR-021 §3: raw
// output never reaches the model, so every read here is LIMIT- and window-
// bounded and returns typed rows, not a firehose.
//
// Design (mirrors sumTokenUsage / readUsageBreakdown, same file):
//   - org_id is a MANDATORY filter — the tenant boundary is never optional.
//   - execution_id narrows to one run; both tables index/sort on it
//     (error_events via idx_error_execution, execution_logs via its ORDER BY
//     prefix (org_id, execution_id, created_at)).
//   - LIMIT caps the row count; an optional lookback window caps the scan.
//   - UInt/DateTime columns arrive as strings on the JSONEachRow wire; callers
//     get already-coerced, typed rows.

import { clickhouse, NIL_UUID } from "./clickhouse";

/** Hard ceiling on rows returned by either helper — bounds the model payload. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
/** Default lookback: matches the 90-day TTL on both tables; older rows are gone. */
const DEFAULT_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

export type ExecutionLogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** One `error_events` row for an execution, coerced to typed fields. */
export interface ExecutionErrorEvent {
  errorId: string;
  severity: "fatal" | "error" | "warn";
  source: string;
  errorClass: string;
  message: string;
  stack: string;
  capability: string;
  requestId: string;
  fingerprint: string;
  stepId: string | null;
  createdAt: string;
}

/** One `execution_logs` row for an execution, coerced to typed fields. */
export interface ExecutionLogLine {
  stepId: string | null;
  logLevel: ExecutionLogLevel;
  message: string;
  metadata: string;
  createdAt: string;
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
 * Fetch the errors captured for one agent execution, newest first. Bounded by
 * `limit` (≤ 500) and a lookback window (default 90 days). Returns [] for the
 * nil-UUID sentinel — that id means "no execution", never a run to inspect.
 */
export async function fetchErrorEventsForExecution(args: {
  orgId: string;
  executionId: string;
  limit?: number;
  /** Absolute epoch-ms floor on created_at. Defaults to now − 90 days. */
  sinceMs?: number;
}): Promise<ExecutionErrorEvent[]> {
  if (!args.executionId || args.executionId === NIL_UUID) return [];
  const limit = clampLimit(args.limit);
  const since = args.sinceMs ?? Date.now() - DEFAULT_LOOKBACK_MS;

  const result = await clickhouse().query({
    query: `
      SELECT
        error_id,
        severity,
        source,
        error_class,
        message,
        stack,
        capability,
        request_id,
        fingerprint,
        toString(step_id) AS step_id,
        created_at
      FROM error_events
      WHERE org_id = {orgId:UUID}
        AND execution_id = {executionId:UUID}
        AND created_at >= {since:DateTime64(3)}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32}
    `,
    query_params: {
      orgId: args.orgId,
      executionId: args.executionId,
      since: chDateTime(since),
      limit,
    },
    format: "JSONEachRow",
  });

  interface Raw {
    error_id: string;
    severity: "fatal" | "error" | "warn";
    source: string;
    error_class: string;
    message: string;
    stack: string;
    capability: string;
    request_id: string;
    fingerprint: string;
    step_id: string;
    created_at: string;
  }
  const rows = (await result.json()) as Raw[];
  return rows.map((r) => ({
    errorId: r.error_id,
    severity: r.severity,
    source: r.source,
    errorClass: r.error_class,
    message: r.message,
    stack: r.stack,
    capability: r.capability,
    requestId: r.request_id,
    fingerprint: r.fingerprint,
    // ClickHouse renders a NULL Nullable(UUID) as the literal string "\\N" via
    // toString(); an unset step is also the nil UUID from a defaulted column.
    stepId: r.step_id === "\\N" || r.step_id === NIL_UUID ? null : r.step_id,
    createdAt: r.created_at,
  }));
}

/**
 * Fetch structured log lines for one agent execution, newest first. Optionally
 * filtered to a set of levels (e.g. only warn/error/fatal). Bounded by `limit`
 * (≤ 500) and a lookback window (default 90 days).
 */
export async function fetchLogsForExecution(args: {
  orgId: string;
  executionId: string;
  /** Restrict to these levels. Omitted/empty → all levels. */
  levels?: readonly ExecutionLogLevel[];
  limit?: number;
  /** Absolute epoch-ms floor on created_at. Defaults to now − 90 days. */
  sinceMs?: number;
}): Promise<ExecutionLogLine[]> {
  if (!args.executionId || args.executionId === NIL_UUID) return [];
  const limit = clampLimit(args.limit);
  const since = args.sinceMs ?? Date.now() - DEFAULT_LOOKBACK_MS;
  const levels = args.levels && args.levels.length > 0 ? args.levels : null;

  const result = await clickhouse().query({
    query: `
      SELECT
        toString(step_id) AS step_id,
        log_level,
        message,
        metadata,
        created_at
      FROM execution_logs
      WHERE org_id = {orgId:UUID}
        AND execution_id = {executionId:UUID}
        AND created_at >= {since:DateTime64(3)}
        ${levels ? "AND log_level IN {levels:Array(String)}" : ""}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32}
    `,
    query_params: {
      orgId: args.orgId,
      executionId: args.executionId,
      since: chDateTime(since),
      limit,
      ...(levels ? { levels } : {}),
    },
    format: "JSONEachRow",
  });

  interface Raw {
    step_id: string;
    log_level: ExecutionLogLevel;
    message: string;
    metadata: string;
    created_at: string;
  }
  const rows = (await result.json()) as Raw[];
  return rows.map((r) => ({
    stepId: r.step_id === "\\N" || r.step_id === NIL_UUID ? null : r.step_id,
    logLevel: r.log_level,
    message: r.message,
    metadata: r.metadata,
    createdAt: r.created_at,
  }));
}

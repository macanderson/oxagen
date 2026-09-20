import type { ClickHouseClient, ResponseJSON } from "@clickhouse/client";
import {
  assertDataPlaneUsable,
  requireScope,
  resolveDataPlane,
  TenantScopeError,
  type ClickHousePlaneConfig,
} from "@oxagen/tenancy";
import { clickhouse } from "./clickhouse";
import { dedicatedClickhouse } from "./data-plane-client";

/**
 * Resolve which physical ClickHouse this organisation's telemetry lives on
 * (ADR-042). `shared` — the default — returns the process singleton, so this is
 * one already-resolved promise and a branch on the hot path.
 *
 * Fail-closed: a degraded or disabled plane throws `DataPlaneUnavailableError`
 * rather than writing the organisation's traces into the platform store it
 * explicitly moved them out of. That is a deliberate departure from the
 * "telemetry never blocks the caller" rule elsewhere in this package: dropping
 * a row on a breaker trip loses data, whereas falling back here would MISFILE
 * it into another operator's store, which is a compliance breach rather than a
 * gap.
 */
async function planeClient(orgId: string): Promise<ClickHouseClient> {
  const plane = await resolveDataPlane(orgId, "clickhouse");
  assertDataPlaneUsable(plane);
  if (plane.mode === "shared") return clickhouse();
  return dedicatedClickhouse({
    orgId,
    config: plane.config as ClickHousePlaneConfig,
    configDigest: plane.configDigest,
  });
}

/**
 * Insert rows into a ClickHouse table, stamping `org_id` and `workspace_id`
 * from the active tenant scope onto every row. Fail-closed: throws
 * `TenantScopeError` when no scope is active.
 *
 * Callers should NOT include `org_id`/`workspace_id` in the row objects —
 * the seam stamps them. Any caller-supplied values are overwritten by the
 * scope to prevent spoofing.
 */
export async function chInsert(
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const { orgId, workspaceId } = requireScope();
  const values = rows.map((r) => ({
    ...r,
    org_id: orgId,
    workspace_id: workspaceId,
  }));
  const ch = await planeClient(orgId);
  await ch.insert({ table, values, format: "JSONEachRow" });
}

/**
 * Read a single table through a derived source scoped to the active tenant.
 * Only one SELECT and one unqualified table source are admitted. Joins,
 * subqueries, comments, and set operations require a dedicated reviewed
 * reader instead. Tenant parameters override caller-supplied values.
 */
export async function chSelect<T>(q: {
  query: string;
  params?: Record<string, unknown>;
}): Promise<ResponseJSON<T>> {
  const { orgId, workspaceId } = requireScope();
  const scopedQuery = scopeSelectSource(q.query);
  const ch = await planeClient(orgId);
  const result = await ch.query({
    query: scopedQuery,
    query_params: { ...q.params, orgId, workspaceId },
    format: "JSON",
  });
  return result.json<T>();
}

/** Scope the source before any caller predicate, grouping, or aggregation. */
function scopeSelectSource(query: string): string {
  const source = /\bFROM\s+([a-z_][a-z0-9_]*)(\s+FINAL)?(?=\s|$)/i.exec(query);
  const supported =
    /^\s*SELECT\b/i.test(query) &&
    (query.match(/\bSELECT\b/gi)?.length ?? 0) === 1 &&
    (query.match(/\bFROM\b/gi)?.length ?? 0) === 1 &&
    !/;|--|\/\*|\*\/|#|\b(?:JOIN|UNION|INTERSECT|EXCEPT|WITH|INTO|SETTINGS|FORMAT)\b/i.test(
      query,
    );
  if (!supported || !source) {
    throw new TenantScopeError(
      "ClickHouse org_id isolation requires a single-table SELECT",
    );
  }
  const tail = query.slice(source.index + source[0].length);
  if (
    !/^\s*(?:$|WHERE\b|GROUP\s+BY\b|HAVING\b|ORDER\s+BY\b|LIMIT\b)/i.test(tail)
  ) {
    throw new TenantScopeError(
      "ClickHouse org_id isolation does not support this table source",
    );
  }
  const table = source[1];
  const final = source[2] ? " FINAL" : "";
  return (
    query.slice(0, source.index) +
    `FROM (SELECT * FROM ${table}${final} WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}) AS ${table}` +
    tail
  );
}

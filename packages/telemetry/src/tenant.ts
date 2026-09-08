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
 * Execute a ClickHouse SELECT query, binding `orgId` and `workspaceId` from
 * the active tenant scope as named query params alongside any caller-supplied
 * params. Throws `TenantScopeError` when:
 *  - No scope is active (fail-closed).
 *  - The query string does not mention `org_id` anywhere.
 *
 * The second check is a word-boundary regex over the query text, so it catches
 * only the blunt mistake (`SELECT * FROM events` with no WHERE at all). It is
 * NOT proof of tenant isolation: `org_id` appearing in a SELECT list, a
 * comment, a GROUP BY, or an OR'd predicate all satisfy it. Binding orgId /
 * workspaceId as params does not filter either — the query author still has to
 * write the `WHERE org_id = {orgId:UUID}` clause. Review every new chSelect
 * query for a real equality filter; the regex will not catch it for you.
 *
 * A query that genuinely must run unscoped must use the raw `clickhouse()`
 * client directly inside `packages/telemetry` — not this helper.
 *
 * @returns A `ResponseJSON<T>` envelope with a `data: T[]` field. The "JSON"
 * ClickHouse wire format always wraps rows in this shape; callers destructure
 * `result.data` to access the row array.
 */
export async function chSelect<T>(q: {
  query: string;
  params?: Record<string, unknown>;
}): Promise<ResponseJSON<T>> {
  const { orgId, workspaceId } = requireScope();
  if (!/\borg_id\b/.test(q.query)) {
    throw new TenantScopeError(
      `ClickHouse read must filter by org_id: ${q.query.slice(0, 80)}`,
    );
  }
  const ch = await planeClient(orgId);
  const result = await ch.query({
    query: q.query,
    query_params: { ...q.params, orgId, workspaceId },
    format: "JSON",
  });
  return result.json<T>();
}

import type { ResponseJSON } from "@clickhouse/client";
import { requireScope, TenantScopeError } from "@oxagen/tenancy";
import { clickhouse } from "./clickhouse";

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
  await clickhouse().insert({ table, values, format: "JSONEachRow" });
}

/**
 * Execute a ClickHouse SELECT query, binding `orgId` and `workspaceId` from
 * the active tenant scope as named query params alongside any caller-supplied
 * params. Throws `TenantScopeError` when:
 *  - No scope is active (fail-closed).
 *  - The query string does not reference `org_id` (guard against cross-tenant
 *    reads that forget to filter — e.g. `SELECT * FROM events` with no WHERE).
 *
 * The guard uses a simple substring match; it is intentionally conservative
 * so that `org_id` in a comment still passes (cheap and correct in practice).
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
  const result = await clickhouse().query({
    query: q.query,
    query_params: { ...q.params, orgId, workspaceId },
    format: "JSON",
  });
  return result.json<T>();
}

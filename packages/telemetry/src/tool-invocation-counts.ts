// tool-invocation-counts.ts — the registry's "calls 30d" column (#2958).
//
// One aggregate over `tool_invocations` for the capability ids on a page of
// the registry, scoped to the active tenant through `chSelect` (which binds
// org_id and workspace_id from the tenant scope and resolves the org's data
// plane, ADR-042). The caller decides what an unanswered store means; here a
// count is a number or absent.

import { chSelect } from "./tenant";

export const TOOL_INVOCATION_WINDOW_DAYS = 30;

/**
 * Every invocation recorded in the last 30 days, by capability id, for the
 * ids given: completed, failed and parked alike. A parked call is a call the
 * agent made; it is only kept out of failure counts. An id with no rows is
 * absent from the map.
 */
export async function countRecentToolInvocations(
  capabilityIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (capabilityIds.length === 0) return counts;
  const result = await chSelect<{ capability_name: string; calls: string }>({
    query: `
      SELECT capability_name, count() AS calls
      FROM tool_invocations
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND capability_name IN ({capabilityIds:Array(String)})
        AND created_at >= now() - INTERVAL {windowDays:UInt16} DAY
      GROUP BY capability_name
    `,
    params: {
      capabilityIds: [...capabilityIds],
      windowDays: TOOL_INVOCATION_WINDOW_DAYS,
    },
  });
  for (const row of result.data) {
    counts.set(row.capability_name, Number(row.calls));
  }
  return counts;
}

import { schema, withTenantDb } from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.shared";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Whether `runId` names the in-app assistant's run: an `agent_runs` row in
 * the scope's workspace on an in-app surface (`IN_APP_AGENT_SURFACES`).
 *
 * The workspace does not monitor the assistant (ADR-235, 2026-10-02
 * amendment), so a job that feeds a workspace view asks this first. A Tacho
 * session's id (`tse_…`) never names an `agent_runs` row, so it reads false
 * with no query.
 */
export async function isInAppRun(
  scope: { orgId: string; workspaceId: string },
  runId: string,
): Promise<boolean> {
  if (!runId.startsWith("arun_")) return false;
  const runs = schema.agentRuns;
  const rows = await runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.orgId, scope.orgId),
            eq(runs.workspaceId, scope.workspaceId),
            eq(runs.publicId, runId),
            inArray(runs.surface, [...IN_APP_AGENT_SURFACES]),
          ),
        )
        .limit(1),
    ),
  );
  return rows.length > 0;
}

import { projectExecutionToolUsage } from "@oxagen/agent";
import type { CapabilityContext } from "@oxagen/oxagen";
import { logger } from "./logger";

/**
 * Project the tools an execution invoked into the graph, swallowing every
 * failure.
 *
 * The projection itself throws on a Postgres or Neo4j failure so a backfill
 * caller sees a real signal (packages/agent/src/dispatch/tool-projection.ts);
 * catching is the call site's job, and both terminal handlers want the same
 * answer — a graph write must never fail or slow an execution that has already
 * been persisted. Shared rather than inlined twice so the two paths cannot
 * drift on what "best effort" means.
 *
 * Call it AFTER the recording transaction commits: the projection opens its
 * own tenant-scoped connection and would otherwise read a tree that is not yet
 * visible to it.
 */
export async function projectToolUsageBestEffort(
  executionId: string,
  ctx: Pick<CapabilityContext, "orgId" | "workspaceId">,
): Promise<void> {
  try {
    await projectExecutionToolUsage({
      executionId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    });
  } catch (err) {
    logger.warn(
      { err, executionId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "tool graph projection failed — execution is still recorded",
    );
  }
}

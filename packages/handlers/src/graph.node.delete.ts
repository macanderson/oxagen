import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeDelete } from "@oxagen/oxagen/contracts/graph.node.delete";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { emitGraphDeletionTelemetry } from "./graph.telemetry";
import { logger } from "./logger";

export const graphNodeDeleteHandler: CapabilityHandler<typeof graphNodeDelete> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  const startedAt = Date.now();

  let deleted = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // Scope by BOTH orgId AND workspaceId. Org-only filtering would let a
      // node from another workspace in the same org be deleted if publicIds
      // collide — a tenant-isolation breach (policy §0).
      // DETACH DELETE removes the node and all its relationships atomically.
      const result = await session.run(
        `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         WITH n, count(n) AS found
         DETACH DELETE n
         RETURN found > 0 AS wasDeleted`,
        { nodeId: input.nodeId },
      );

      const record = result.records[0];
      deleted = record ? (record.get("wasDeleted") as boolean) : false;
    } finally {
      await session.close();
    }
  });

  logger.info(
    { nodeId: input.nodeId, deleted, orgId, workspaceId },
    "graph.node.delete: node deletion attempted",
  );

  // Destructive op — emit a ClickHouse tool-invocation row for audit/analytics
  // via the shared @oxagen/telemetry seam. Fire-and-forget so the response is
  // never blocked or failed by telemetry latency.
  emitGraphDeletionTelemetry(
    { orgId, workspaceId, surface: ctx.surface, messageId: ctx.messageId },
    {
      capability: graphNodeDelete.name,
      latencyMs: Date.now() - startedAt,
      succeeded: deleted,
    },
  );

  return { deleted };
};

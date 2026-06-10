import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeDelete } from "@oxagen/oxagen/contracts/graph.node.delete";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

export const graphNodeDeleteHandler: CapabilityHandler<typeof graphNodeDelete> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  let deleted = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // DETACH DELETE removes the node and all its relationships atomically.
      const result = await session.run(
        `MATCH (n:KnowledgeNode {publicId: $nodeId, orgId: $orgId})
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

  return { deleted };
};

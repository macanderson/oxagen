import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeGet } from "@oxagen/oxagen/contracts/graph.node.get";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";
import { safeParseProperties } from "./lib/graph-properties";

export const graphNodeGetHandler: CapabilityHandler<
  typeof graphNodeGet
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  type NodeResult = {
    nodeId: string;
    label: string;
    displayName: string;
    description: string | null;
    properties: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string | null;
  } | null;

  let nodeResult: NodeResult = null;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // Scope by BOTH orgId AND workspaceId. Filtering on org alone lets a
      // node from another workspace in the same org be read if publicIds
      // collide — a tenant-isolation breach (policy §0). workspaceId is
      // matched in the node pattern so the index can prune up front.
      const result = await session.run(
        `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         WHERE n.is_system = false
         RETURN
           n.publicId    AS nodeId,
           n.label       AS label,
           n.displayName AS displayName,
           n.description AS description,
           n.properties  AS properties,
           n.createdAt   AS createdAt,
           n.updatedAt   AS updatedAt`,
        { nodeId: input.nodeId, orgId, workspaceId },
      );

      const record = result.records[0];
      if (record) {
        const rawProperties = record.get("properties") as unknown;
        nodeResult = {
          nodeId: record.get("nodeId") as string,
          label: record.get("label") as string,
          displayName: record.get("displayName") as string,
          description: record.get("description") as string | null,
          // Contract: null when the node has no properties column at all;
          // a present-but-unreadable blob degrades to {} instead of 500ing
          // the whole detail panel (safeParseProperties never throws).
          properties:
            rawProperties == null
              ? null
              : safeParseProperties(rawProperties, { nodeId: input.nodeId }),
          createdAt: String(record.get("createdAt")),
          updatedAt:
            record.get("updatedAt") != null
              ? String(record.get("updatedAt"))
              : null,
        };
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    { nodeId: input.nodeId, found: nodeResult !== null, orgId, workspaceId },
    "graph.node.get: node fetched",
  );

  return { node: nodeResult };
};

import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeUpsert } from "@oxagen/oxagen/contracts/graph.node.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

export const graphNodeUpsertHandler: CapabilityHandler<typeof graphNodeUpsert> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  // Natural key is always workspace-scoped: externalId when provided
  // (prefixed with workspaceId so the same external id in two workspaces of the
  // same org does not collide), otherwise label+displayName+workspaceId.
  const naturalKey = input.externalId
    ? `ext:${workspaceId}:${input.externalId}`
    : `${input.label}:${input.displayName}:${workspaceId}`;

  const propertiesJson = input.properties ? JSON.stringify(input.properties) : null;

  let nodeId = "";
  let created = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        // MERGE key includes orgId AND workspaceId so a node is uniquely scoped
        // to its workspace; this prevents a same-org sibling workspace from
        // matching (and overwriting) another workspace's node. $orgId and
        // $workspaceId are injected automatically by scopedSession().
        `MERGE (n:KnowledgeNode {naturalKey: $naturalKey, orgId: $orgId, workspaceId: $workspaceId})
         ON CREATE SET
           n.publicId     = randomUUID(),
           n.label        = $label,
           n.displayName  = $displayName,
           n.description  = $description,
           n.properties   = $properties,
           n.createdAt    = datetime(),
           n.updatedAt    = datetime(),
           n._created     = true
         ON MATCH SET
           n.label        = $label,
           n.displayName  = $displayName,
           n.description  = $description,
           n.properties   = $properties,
           n.updatedAt    = datetime(),
           n._created     = false
         RETURN n.publicId AS nodeId, n._created AS wasCreated`,
        {
          naturalKey,
          label: input.label,
          displayName: input.displayName,
          description: input.description ?? null,
          properties: propertiesJson,
        },
      );

      const record = result.records[0];
      if (!record) {
        throw new Error("graph.node.upsert: MERGE returned no record");
      }

      nodeId = record.get("nodeId") as string;
      created = record.get("wasCreated") as boolean;
    } finally {
      await session.close();
    }
  });

  logger.info(
    { nodeId, created, label: input.label, orgId, workspaceId },
    "graph.node.upsert: node upserted",
  );

  return { nodeId, created };
};

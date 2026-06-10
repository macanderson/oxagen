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

  // Natural key: externalId when provided; otherwise label+displayName+workspaceId
  const naturalKey = input.externalId
    ? `ext:${input.externalId}`
    : `${input.label}:${input.displayName}:${workspaceId}`;

  const propertiesJson = input.properties ? JSON.stringify(input.properties) : null;

  let nodeId = "";
  let created = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        `MERGE (n:KnowledgeNode {naturalKey: $naturalKey, orgId: $orgId})
         ON CREATE SET
           n.publicId     = randomUUID(),
           n.workspaceId  = $workspaceId,
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

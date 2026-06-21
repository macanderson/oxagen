import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphEdgeUpsert } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import type { GraphEdgeType } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

// Static map: each allowed edge type has its own MERGE template.
// No dynamic Cypher — the edge type selector pattern prevents injection and
// keeps the query planner happy with static relationship types.
//
// Both endpoints are scoped by BOTH orgId AND workspaceId. Org-only scoping
// (the previous behaviour) let a caller in one workspace MERGE an edge against
// a same-publicId node in another workspace of the same org — a tenant-isolation
// breach (policy §0). This mirrors the fix already applied to graph.edge.delete.
const EDGE_TYPE_QUERIES: Record<GraphEdgeType, string> = {
  RELATED_TO: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
               MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
               MERGE (from)-[r:RELATED_TO]->(to)
               ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
               ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
               RETURN r._created AS wasCreated`,

  PART_OF: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
             MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
             MERGE (from)-[r:PART_OF]->(to)
             ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
             ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
             RETURN r._created AS wasCreated`,

  CAUSED_BY: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
               MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
               MERGE (from)-[r:CAUSED_BY]->(to)
               ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
               ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
               RETURN r._created AS wasCreated`,

  REFERENCES: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MERGE (from)-[r:REFERENCES]->(to)
                ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
                ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
                RETURN r._created AS wasCreated`,

  SIMILAR_TO: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MERGE (from)-[r:SIMILAR_TO]->(to)
                ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
                ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
                RETURN r._created AS wasCreated`,

  DEPENDS_ON: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MERGE (from)-[r:DEPENDS_ON]->(to)
                ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
                ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
                RETURN r._created AS wasCreated`,

  CREATED_BY: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
                MERGE (from)-[r:CREATED_BY]->(to)
                ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
                ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
                RETURN r._created AS wasCreated`,

  MENTIONS: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
              MATCH (to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
              MERGE (from)-[r:MENTIONS]->(to)
              ON CREATE SET r.properties = $properties, r.createdAt = datetime(), r._created = true
              ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
              RETURN r._created AS wasCreated`,
};

export const graphEdgeUpsertHandler: CapabilityHandler<typeof graphEdgeUpsert> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  const query = EDGE_TYPE_QUERIES[input.edgeType];
  if (!query) {
    throw new Error(
      `graph.edge.upsert: unsupported edgeType "${input.edgeType}". Allowed: ${Object.keys(EDGE_TYPE_QUERIES).join(", ")}`,
    );
  }

  const propertiesJson = input.properties ? JSON.stringify(input.properties) : null;

  let created = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(query, {
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        properties: propertiesJson,
      });

      const record = result.records[0];
      if (!record) {
        throw new Error(
          `graph.edge.upsert: no record returned — check that both nodes exist (fromNodeId=${input.fromNodeId}, toNodeId=${input.toNodeId})`,
        );
      }
      created = record.get("wasCreated") as boolean;
    } finally {
      await session.close();
    }
  });

  // Stable composite edge identifier for the caller.
  const edgeId = `${input.fromNodeId}:${input.edgeType}:${input.toNodeId}`;

  logger.info(
    { edgeId, created, edgeType: input.edgeType, orgId, workspaceId },
    "graph.edge.upsert: edge upserted",
  );

  return { edgeId, created };
};

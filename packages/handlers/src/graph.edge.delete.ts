import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphEdgeDelete } from "@oxagen/oxagen/contracts/graph.edge.delete";
import type { GraphEdgeType } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

// Static map mirrors EDGE_TYPE_QUERIES in graph.edge.upsert — same pattern,
// DELETE variant. One query per relationship type so the Cypher planner sees
// a static relationship type in every case.
const EDGE_DELETE_QUERIES: Record<GraphEdgeType, string> = {
  RELATED_TO: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:RELATED_TO]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
               WITH r, count(r) AS found
               DELETE r
               RETURN found > 0 AS wasDeleted`,

  PART_OF: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:PART_OF]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
             WITH r, count(r) AS found
             DELETE r
             RETURN found > 0 AS wasDeleted`,

  CAUSED_BY: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:CAUSED_BY]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
               WITH r, count(r) AS found
               DELETE r
               RETURN found > 0 AS wasDeleted`,

  REFERENCES: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:REFERENCES]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
                WITH r, count(r) AS found
                DELETE r
                RETURN found > 0 AS wasDeleted`,

  SIMILAR_TO: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:SIMILAR_TO]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
                WITH r, count(r) AS found
                DELETE r
                RETURN found > 0 AS wasDeleted`,

  DEPENDS_ON: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:DEPENDS_ON]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
                WITH r, count(r) AS found
                DELETE r
                RETURN found > 0 AS wasDeleted`,

  CREATED_BY: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:CREATED_BY]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
                WITH r, count(r) AS found
                DELETE r
                RETURN found > 0 AS wasDeleted`,

  MENTIONS: `MATCH (from:KnowledgeNode {publicId: $fromNodeId, orgId: $orgId})-[r:MENTIONS]->(to:KnowledgeNode {publicId: $toNodeId, orgId: $orgId})
              WITH r, count(r) AS found
              DELETE r
              RETURN found > 0 AS wasDeleted`,
};

export const graphEdgeDeleteHandler: CapabilityHandler<typeof graphEdgeDelete> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  const query = EDGE_DELETE_QUERIES[input.edgeType];
  if (!query) {
    throw new Error(
      `graph.edge.delete: unsupported edgeType "${input.edgeType}". Allowed: ${Object.keys(EDGE_DELETE_QUERIES).join(", ")}`,
    );
  }

  let deleted = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(query, {
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
      });

      const record = result.records[0];
      deleted = record ? (record.get("wasDeleted") as boolean) : false;
    } finally {
      await session.close();
    }
  });

  logger.info(
    {
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      edgeType: input.edgeType,
      deleted,
      orgId,
      workspaceId,
    },
    "graph.edge.delete: edge deletion attempted",
  );

  return { deleted };
};

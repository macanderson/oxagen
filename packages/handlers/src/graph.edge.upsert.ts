import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphEdgeUpsert } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { RELATIONSHIP_TYPE_PATTERN } from "@oxagen/oxagen/contracts/graph.relationship.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

// graph.edge.upsert is the one-release DEPRECATION ALIAS of graph.relationship.upsert
// (Workspace Schema Registry §1.2). The fixed GRAPH_EDGE_TYPES enum is GONE (§3.2):
// the relationship type is now any workspace-defined string, validated by the
// always-on lexical RELATIONSHIP_TYPE_PATTERN guard (`^[A-Z][A-Z0-9_]{0,62}$`).
//
// Because the type can no longer be a static map key, the MERGE template is built
// dynamically — but ONLY after the type is re-asserted against the lexical guard,
// which permits no backticks, brackets, whitespace, or Cypher metacharacters. A
// type that passes the guard is therefore safe to interpolate into the relationship
// pattern (defense-in-depth: the contract already rejects non-conforming types).
// Both endpoints are scoped by BOTH orgId AND workspaceId (tenant isolation §0).
function buildUpsertQuery(relationshipType: string): string {
  if (!RELATIONSHIP_TYPE_PATTERN.test(relationshipType)) {
    throw new Error(
      `graph.edge.upsert: relationship type "${relationshipType}" fails the lexical guard`,
    );
  }
  return `MATCH (from:GraphNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
          MATCH (to:GraphNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
          MERGE (from)-[r:${relationshipType}]->(to)
          ON CREATE SET r.properties = $properties, r.is_system = false, r.createdAt = datetime(), r._created = true
          ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false
          RETURN r._created AS wasCreated`;
}

export const graphEdgeUpsertHandler: CapabilityHandler<typeof graphEdgeUpsert> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  const query = buildUpsertQuery(input.relationshipType);

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

  // Stable composite relationship identifier for the caller.
  const edgeId = `${input.fromNodeId}:${input.relationshipType}:${input.toNodeId}`;

  logger.info(
    { edgeId, created, relationshipType: input.relationshipType, orgId, workspaceId },
    "graph.edge.upsert: relationship upserted",
  );

  return { edgeId, created };
};

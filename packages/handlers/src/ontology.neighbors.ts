import type { CapabilityHandler } from "@oxagen/oxagen";
import { ontologyNeighbors } from "@oxagen/oxagen/contracts/ontology.neighbors";
import { GRAPH_EDGE_TYPES, type GraphEdgeType } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

interface NeighborEntry {
  nodeId: string;
  label: string;
  displayName: string;
  description: string | null;
  edgeType: GraphEdgeType;
  direction: "out" | "in";
}

/**
 * Resolve the relationship-type allow-list. Every value is validated against
 * GRAPH_EDGE_TYPES (the fixed allow-list) so the value passed as a Cypher
 * parameter can never widen the type set beyond what the schema permits.
 */
function resolveEdgeTypes(edgeTypes: readonly GraphEdgeType[] | undefined): GraphEdgeType[] {
  const types = edgeTypes && edgeTypes.length > 0 ? [...edgeTypes] : [...GRAPH_EDGE_TYPES];
  for (const t of types) {
    if (!GRAPH_EDGE_TYPES.includes(t)) {
      throw new Error(`ontology.neighbors: unsupported edgeType "${t}"`);
    }
  }
  return types;
}

export const ontologyNeighborsHandler: CapabilityHandler<typeof ontologyNeighbors> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  const edgeTypes = resolveEdgeTypes(input.edgeTypes);

  let found = false;
  const neighbors: NeighborEntry[] = [];
  let truncated = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // 1) Confirm the node exists in THIS org + workspace before reporting any
      //    neighbors — a same-publicId node in another workspace must never be
      //    treated as found (tenant isolation, §0).
      const existsResult = await session.run(
        `MATCH (n:KnowledgeNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         RETURN n.publicId AS nodeId`,
        { nodeId: input.nodeId, orgId, workspaceId },
      );
      if (!existsResult.records[0]) {
        return;
      }
      found = true;

      // Direction filter relative to the anchor node. 'both' applies no filter
      // and the CASE expression below labels each edge's actual orientation.
      const directionClause =
        input.direction === "out"
          ? "AND startNode(r) = n"
          : input.direction === "in"
            ? "AND endNode(r) = n"
            : "";

      // Fetch one extra row beyond the cap so we can flag truncation honestly.
      // BigInt forces the driver to send INTEGER on the Bolt wire — a plain JS
      // number would be serialised as Float and Neo4j rejects it for LIMIT.
      const fetchLimit = BigInt(input.limit + 1);
      const result = await session.run(
        `MATCH (n:KnowledgeNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         MATCH (n)-[r]-(m:KnowledgeNode)
         WHERE m.orgId = $orgId AND m.workspaceId = $workspaceId
           AND type(r) IN $edgeTypes
           ${directionClause}
         RETURN
           m.publicId    AS nodeId,
           m.label       AS label,
           m.displayName AS displayName,
           m.description AS description,
           type(r)       AS edgeType,
           CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS direction
         ORDER BY m.displayName ASC
         LIMIT $fetchLimit`,
        { nodeId: input.nodeId, orgId, workspaceId, edgeTypes, fetchLimit },
      );

      for (const record of result.records) {
        if (neighbors.length >= input.limit) {
          truncated = true;
          break;
        }
        neighbors.push({
          nodeId: record.get("nodeId") as string,
          label: record.get("label") as string,
          displayName: record.get("displayName") as string,
          description: record.get("description") as string | null,
          edgeType: record.get("edgeType") as GraphEdgeType,
          direction: record.get("direction") as "out" | "in",
        });
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    {
      nodeId: input.nodeId,
      direction: input.direction,
      found,
      neighborCount: neighbors.length,
      truncated,
      orgId,
      workspaceId,
    },
    "ontology.neighbors: neighborhood fetched",
  );

  return { nodeId: input.nodeId, found, neighbors, truncated };
};

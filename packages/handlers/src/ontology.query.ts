import type { CapabilityHandler } from "@oxagen/oxagen";
import { ontologyQuery } from "@oxagen/oxagen/contracts/ontology.query";
import { GRAPH_EDGE_TYPES, type GraphEdgeType } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

interface TraversedNode {
  nodeId: string;
  label: string;
  displayName: string;
  description: string | null;
  depth: number;
}

interface TraversedEdge {
  fromNodeId: string;
  toNodeId: string;
  edgeType: GraphEdgeType;
}

/**
 * Build the safe `:TYPE1|TYPE2` relationship-type pattern for a Cypher
 * variable-length match. Every value is validated against GRAPH_EDGE_TYPES
 * (the fixed allow-list) before it reaches here, so this is never a Cypher
 * injection surface — we additionally re-assert membership defensively.
 */
function relTypePattern(edgeTypes: readonly GraphEdgeType[] | undefined): string {
  const types = edgeTypes && edgeTypes.length > 0 ? edgeTypes : GRAPH_EDGE_TYPES;
  for (const t of types) {
    if (!GRAPH_EDGE_TYPES.includes(t)) {
      throw new Error(`ontology.query: unsupported edgeType "${t}"`);
    }
  }
  return types.map((t) => `\`${t}\``).join("|");
}

/** Compose the directional variable-length relationship pattern. */
function buildMatchPattern(
  direction: "out" | "in" | "both",
  relTypes: string,
  maxDepth: number,
): string {
  // maxDepth is validated to an integer in [1,5] by the contract — safe to inline.
  const variable = `[r:${relTypes}*1..${maxDepth}]`;
  switch (direction) {
    case "out":
      return `(start)-${variable}->(reached:KnowledgeNode)`;
    case "in":
      return `(start)<-${variable}-(reached:KnowledgeNode)`;
    case "both":
      return `(start)-${variable}-(reached:KnowledgeNode)`;
  }
}

export const ontologyQueryHandler: CapabilityHandler<typeof ontologyQuery> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  const relTypes = relTypePattern(input.edgeTypes);
  const matchPattern = buildMatchPattern(input.direction, relTypes, input.maxDepth);

  let startNode: TraversedNode | null = null;
  const nodesById = new Map<string, TraversedNode>();
  const edges: TraversedEdge[] = [];
  let truncated = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // 1) Resolve the start node, scoped by BOTH orgId AND workspaceId so a
      //    same-publicId node in another workspace can never seed a traversal
      //    (tenant isolation, §0).
      const startResult = await session.run(
        `MATCH (start:KnowledgeNode {publicId: $startNodeId, orgId: $orgId, workspaceId: $workspaceId})
         RETURN start.publicId AS nodeId, start.label AS label,
                start.displayName AS displayName, start.description AS description`,
        { startNodeId: input.startNodeId, orgId, workspaceId },
      );
      const startRec = startResult.records[0];
      if (!startRec) {
        // Unknown start node — empty result, not an error.
        return;
      }
      startNode = {
        nodeId: startRec.get("nodeId") as string,
        label: startRec.get("label") as string,
        displayName: startRec.get("displayName") as string,
        description: startRec.get("description") as string | null,
        depth: 0,
      };
      nodesById.set(startNode.nodeId, startNode);

      // 2) Walk the graph. Every reached node and every relationship along the
      //    path is constrained to the same org + workspace. We fetch one extra
      //    row beyond `limit` to detect truncation.
      // BigInt forces the Bolt driver to send INTEGER — plain JS numbers become
      // Float and Neo4j rejects them for LIMIT.
      const fetchLimit = BigInt(input.limit + 1);
      const traverseResult = await session.run(
        `MATCH (start:KnowledgeNode {publicId: $startNodeId, orgId: $orgId, workspaceId: $workspaceId})
         MATCH path = ${matchPattern}
         WHERE reached.orgId = $orgId AND reached.workspaceId = $workspaceId
           AND ALL(n IN nodes(path) WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId)
         WITH reached, length(path) AS depth, relationships(path) AS rels, nodes(path) AS pathNodes
         ORDER BY depth ASC
         LIMIT $fetchLimit
         RETURN
           reached.publicId    AS nodeId,
           reached.label       AS label,
           reached.displayName AS displayName,
           reached.description AS description,
           depth,
           [rel IN rels | type(rel)] AS relTypes,
           [n IN pathNodes | n.publicId] AS pathNodeIds`,
        {
          startNodeId: input.startNodeId,
          orgId,
          workspaceId,
          fetchLimit,
        },
      );

      let kept = 0;
      for (const record of traverseResult.records) {
        const nodeId = record.get("nodeId") as string;
        const depth = toNumber(record.get("depth"));

        if (!nodesById.has(nodeId)) {
          if (kept >= input.limit) {
            truncated = true;
            continue;
          }
          nodesById.set(nodeId, {
            nodeId,
            label: record.get("label") as string,
            displayName: record.get("displayName") as string,
            description: record.get("description") as string | null,
            depth,
          });
          kept += 1;
        }

        // Reconstruct the edges along this path. relTypes[i] connects
        // pathNodeIds[i] and pathNodeIds[i+1]; orientation follows the
        // traversal direction.
        const relTypesAlong = record.get("relTypes") as string[];
        const pathNodeIds = record.get("pathNodeIds") as string[];
        for (let i = 0; i < relTypesAlong.length; i += 1) {
          const a = pathNodeIds[i];
          const b = pathNodeIds[i + 1];
          const edgeType = relTypesAlong[i] as GraphEdgeType;
          if (a == null || b == null) continue;
          const [from, to] = input.direction === "in" ? [b, a] : [a, b];
          if (!edges.some((e) => e.fromNodeId === from && e.toNodeId === to && e.edgeType === edgeType)) {
            edges.push({ fromNodeId: from, toNodeId: to, edgeType });
          }
        }
      }
    } finally {
      await session.close();
    }
  });

  const nodes = [...nodesById.values()];
  // Keep only edges whose endpoints survived the node cap.
  const keptIds = new Set(nodes.map((n) => n.nodeId));
  const keptEdges = edges.filter((e) => keptIds.has(e.fromNodeId) && keptIds.has(e.toNodeId));

  logger.info(
    {
      startNodeId: input.startNodeId,
      direction: input.direction,
      maxDepth: input.maxDepth,
      nodeCount: nodes.length,
      edgeCount: keptEdges.length,
      truncated,
      orgId,
      workspaceId,
    },
    "ontology.query: traversal completed",
  );

  return { startNode, nodes, edges: keptEdges, truncated };
};

/** Normalise Neo4j integer columns to a JS number. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (
    value != null &&
    typeof value === "object" &&
    "low" in value &&
    typeof (value as { low: unknown }).low === "number"
  ) {
    return (value as { low: number }).low;
  }
  return 0;
}

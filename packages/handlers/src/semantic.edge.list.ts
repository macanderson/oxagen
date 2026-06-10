import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeList } from "@oxagen/oxagen/contracts/semantic.edge.list";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { logger } from "./logger";

/**
 * semantic.edge.list handler.
 *
 * Paginated browse of ALL InferredEdge nodes (any approval status) for a
 * workspace. Supports filtering by relationship type, connector sourceId, and
 * confidence band. Used by the semantic-edge-viewer component and MCP tools.
 */
export const semanticEdgeListHandler: CapabilityHandler<typeof semanticEdgeList> = async (
  input,
  ctx,
) => {
  const { type, sourceId, confidenceMin, confidenceMax, limit, offset } = input;

  const result = await runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
    const sess = scopedSession();
    try {
      const rows = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId})
         WHERE ($type IS NULL OR ie.relationshipType = $type)
           AND ($sourceId IS NULL OR ie.connectionId = $sourceId)
           AND ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
           AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
         RETURN
           ie.id               AS id,
           ie.sourceNodeId     AS sourceNodeId,
           ie.targetName       AS targetName,
           ie.targetType       AS targetType,
           ie.relationshipType AS type,
           ie.confidence       AS confidence,
           ie.connectionId     AS connectorId,
           ie.connectionId     AS sourceId,
           ie.approvalStatus   AS approvalStatus,
           toString(ie.approvedAt)  AS approvedAt,
           ie.approvedBy       AS approvedBy,
           toString(ie.inferredAt)  AS inferredAt
         ORDER BY ie.confidence DESC
         SKIP $offset
         LIMIT $limit`,
        {
          type: type ?? null,
          sourceId: sourceId ?? null,
          confidenceMin: confidenceMin ?? null,
          confidenceMax: confidenceMax ?? null,
          offset: BigInt(offset),
          limit: BigInt(limit),
        },
      );

       
      const edges: SemanticEdge[] = rows.records.map((r) => {
        const approvalStatus = r.get("approvalStatus") as string;
        const isApproved = approvalStatus === "approved";
        return {
          id: r.get("id") as string,
          sourceNodeId: r.get("sourceNodeId") as string,
          targetNodeId: r.get("targetName") as string,
          type: r.get("type") as string,
          confidence: Number(r.get("confidence")),
          source: {
            connectorId: r.get("connectorId") as string,
            sourceId: r.get("sourceId") as string,
          },
          inferredAt: r.get("inferredAt") as string,
          approved: isApproved,
          approvedAt: (r.get("approvedAt") as string | null) ?? null,
          approvedBy: (r.get("approvedBy") as string | null) ?? null,
        };
      });
       

      const countRow = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId})
         WHERE ($type IS NULL OR ie.relationshipType = $type)
           AND ($sourceId IS NULL OR ie.connectionId = $sourceId)
           AND ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
           AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
         RETURN count(ie) AS total`,
        {
          type: type ?? null,
          sourceId: sourceId ?? null,
          confidenceMin: confidenceMin ?? null,
          confidenceMax: confidenceMax ?? null,
        },
      );

       
      const total = Number(countRow.records[0]?.get("total") ?? 0);
       

      return { edges, total };
    } finally {
      await sess.close();
    }
  });

  logger.info(
    {
      total: result.total,
      returned: result.edges.length,
      type,
      sourceId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "semantic.edge.list: fetched",
  );

  return {
    edges: result.edges,
    total: result.total,
    limit,
    offset,
  };
};

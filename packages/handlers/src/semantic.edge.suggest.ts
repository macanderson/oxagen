import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeSuggest } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { logger } from "./logger";

/**
 * semantic.edge.suggest handler.
 *
 * Queries Neo4j for InferredEdge nodes with approvalStatus = "pending", filtered
 * by confidence range and sorted by confidence descending. Returns up to `limit`
 * candidates for the approval flow UI.
 */
export const semanticEdgeSuggestHandler: CapabilityHandler<typeof semanticEdgeSuggest> = async (
  input,
  ctx,
) => {
  const { confidenceMin, confidenceMax, limit } = input;

  const result = await runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
    const sess = scopedSession();
    try {
      const rows = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId, approvalStatus: 'pending'})
         WHERE ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
           AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
         RETURN
           ie.id               AS id,
           ie.sourceNodeId     AS sourceNodeId,
           ie.targetType       AS targetType,
           ie.targetName       AS targetName,
           ie.relationshipType AS type,
           ie.confidence       AS confidence,
           ie.connectionId     AS connectorId,
           ie.connectionId     AS sourceId,
           toString(ie.inferredAt) AS inferredAt
         ORDER BY ie.confidence DESC
         LIMIT $limit`,
        {
          confidenceMin: confidenceMin ?? null,
          confidenceMax: confidenceMax ?? null,
          limit: BigInt(limit),
        },
      );

       
      const suggestions: SemanticEdge[] = rows.records.map((r) => ({
        id: r.get("id") as string,
        sourceNodeId: r.get("sourceNodeId") as string,
        targetNodeId: r.get("targetName") as string, // pending edge has no materialised targetNodeId
        type: r.get("type") as string,
        confidence: Number(r.get("confidence")),
        source: {
          connectorId: r.get("connectorId") as string,
          sourceId: r.get("sourceId") as string,
        },
        inferredAt: r.get("inferredAt") as string,
        approved: false,
        approvedAt: null,
        approvedBy: null,
      }));
       

      // Count query (separate, cheaper than counting all via COLLECT)
      const countRow = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId, approvalStatus: 'pending'})
         WHERE ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
           AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
         RETURN count(ie) AS total`,
        {
          confidenceMin: confidenceMin ?? null,
          confidenceMax: confidenceMax ?? null,
        },
      );

       
      const total = Number(countRow.records[0]?.get("total") ?? 0);
       

      return { suggestions, total };
    } finally {
      await sess.close();
    }
  });

  logger.info(
    {
      total: result.total,
      returned: result.suggestions.length,
      confidenceMin,
      confidenceMax,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "semantic.edge.suggest: fetched",
  );

  return {
    suggestions: result.suggestions,
    total: result.total,
    limit,
  };
};

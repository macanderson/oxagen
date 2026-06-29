import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeList } from "@oxagen/oxagen/contracts/semantic.edge.list";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { logger } from "./logger";
import { parseNodeProperties, buildRelationshipProperties } from "./lib/semantic-edge-refs";

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
      // Parallelize page and count queries (independent, same filter parameters)
      const params = {
        type: type ?? null,
        sourceId: sourceId ?? null,
        confidenceMin: confidenceMin ?? null,
        confidenceMax: confidenceMax ?? null,
        offset: BigInt(offset),
        limit: BigInt(limit),
      };

      // Rows then count, run SEQUENTIALLY on the one scoped session — NOT via
      // Promise.all(). A Neo4j session permits only a single in-flight query
      // (auto-commit transaction) at a time, so firing both sess.run() calls
      // concurrently throws "Queries cannot be run directly on a session with an
      // open transaction" (regression #303). Parallelism would require a session
      // per query; these reads are cheap.
      const rows = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId})
           WHERE ($type IS NULL OR ie.relationshipType = $type)
             AND ($sourceId IS NULL OR ie.connectionId = $sourceId)
             AND ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
             AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
           OPTIONAL MATCH (src:GraphNode {publicId: ie.sourceNodeId, orgId: $orgId, workspaceId: $workspaceId})
           RETURN
             ie.id               AS id,
             ie.sourceNodeId     AS sourceNodeId,
             coalesce(src.displayName, src.name, src.publicId, ie.sourceNodeId) AS sourceDisplayName,
             coalesce(src.label, src.type, 'Node')             AS sourceLabel,
             src.properties      AS sourceProperties,
             ie.targetName       AS targetName,
             ie.targetType       AS targetType,
             ie.relationshipType AS type,
             ie.confidence       AS confidence,
             ie.connectionId     AS connectorId,
             ie.connectionId     AS sourceId,
             ie.llmModel         AS llmModel,
             ie.approvalStatus   AS approvalStatus,
             toString(ie.approvedAt)  AS approvedAt,
             ie.approvedBy       AS approvedBy,
             toString(ie.inferredAt)  AS inferredAt
           ORDER BY ie.confidence DESC
           SKIP $offset
           LIMIT $limit`,
        params,
      );
      const countRow = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId})
           WHERE ($type IS NULL OR ie.relationshipType = $type)
             AND ($sourceId IS NULL OR ie.connectionId = $sourceId)
             AND ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
             AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
           RETURN count(ie) AS total`,
        params,
      );

      const edges: SemanticEdge[] = rows.records.map((r) => {
        const approvalStatus = r.get("approvalStatus") as string;
        const isApproved = approvalStatus === "approved";
        const sourceNodeId = r.get("sourceNodeId") as string;
        const targetName = r.get("targetName") as string;
        const targetType = (r.get("targetType") as string | null) ?? "Node";
        const type = r.get("type") as string;
        const confidence = Number(r.get("confidence"));
        const connectorId = (r.get("connectorId") as string | null) ?? "";
        const inferredAt = r.get("inferredAt") as string;
        const llmModel = (r.get("llmModel") as string | null) ?? null;
        const sourceDisplayName = (r.get("sourceDisplayName") as string | null) ?? sourceNodeId;
        const sourceLabel = (r.get("sourceLabel") as string | null) ?? "Node";

        return {
          id: r.get("id") as string,
          sourceNodeId,
          targetNodeId: targetName,
          type,
          confidence,
          source: {
            connectorId,
            sourceId: (r.get("sourceId") as string | null) ?? connectorId,
          },
          inferredAt,
          approved: isApproved,
          approvedAt: (r.get("approvedAt") as string | null) ?? null,
          approvedBy: (r.get("approvedBy") as string | null) ?? null,
          sourceNode: {
            id: sourceNodeId,
            label: sourceLabel,
            displayName: sourceDisplayName,
            properties: parseNodeProperties(r.get("sourceProperties")),
          },
          targetNode: {
            id: null,
            label: targetType,
            displayName: targetName,
            properties: {},
          },
          relationshipProperties: buildRelationshipProperties({
            relationshipType: type,
            confidence,
            model: llmModel,
            connector: connectorId,
            inferredAt,
            approvalStatus,
          }),
        };
      });

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

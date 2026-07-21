import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeSuggest } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { logger } from "./logger";
import { parseNodeProperties, buildRelationshipProperties } from "./lib/semantic-edge-refs";
import { effectiveGraphScope } from "./lib/effective-graph-scope";

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

  // Agent RBAC Phase 3 (spec §3.6 + §6 Q3): filter pending proposals to the
  // agent's effective GraphScope so an out-of-scope inferred edge is never even
  // surfaced for review (fail-fast at proposal-review time). The InferredEdge
  // carries the PROPOSED target label + relationship type as PROPERTIES
  // (`ie.targetType` / `ie.relationshipType`), so those are what the reserved
  // scope markers filter — REAL predicates, added only for constrained
  // dimensions. `undefined` for humans → byte-identical pass-through.
  const scope = effectiveGraphScope(ctx, semanticEdgeSuggest.name);
  const scoped = scope !== undefined;
  const scopeLabelClause =
    scope?.labels !== undefined ? "AND ie.targetType IN $__scopeLabels" : "";
  const scopeRelClause =
    scope?.relationshipTypes !== undefined
      ? "AND ie.relationshipType IN $__scopeRelTypes"
      : "";
  // The seam fails closed on a parameterized `LIMIT $x` under a maxNodes budget,
  // so an agent-scoped read uses a literal LIMIT (`limit` is contract-bounded
  // 1–250). Humans keep the BigInt-typed `$limit` parameter (byte-identical).
  const limitLine = scoped ? `LIMIT ${limit}` : "LIMIT $limit";

  const result = await runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
    const sess = scopedSession(scope);
    try {
      // OPTIONAL MATCH the source node by its publicId so we can cite it by its
      // human label + properties (never a bare UUID). publicId is unique, so the
      // OPTIONAL MATCH can never fan out the result set. The coalesce chains
      // mirror graph.node.list, falling back to name→publicId for placeholder
      // nodes written without explicit display fields.
      const rows = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId, approvalStatus: 'pending'})
         WHERE ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
           AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
           ${scopeLabelClause}
           ${scopeRelClause}
         OPTIONAL MATCH (src:GraphNode {publicId: ie.sourceNodeId, orgId: $orgId, workspaceId: $workspaceId})
         RETURN
           ie.id               AS id,
           ie.sourceNodeId     AS sourceNodeId,
           coalesce(src.displayName, src.name, src.publicId, ie.sourceNodeId) AS sourceDisplayName,
           coalesce(src.label, src.type, 'Node')             AS sourceLabel,
           src.properties      AS sourceProperties,
           ie.targetType       AS targetType,
           ie.targetName       AS targetName,
           ie.relationshipType AS type,
           ie.confidence       AS confidence,
           ie.connectionId     AS connectorId,
           ie.connectionId     AS sourceId,
           ie.llmModel         AS llmModel,
           toString(ie.inferredAt) AS inferredAt
         ORDER BY ie.confidence DESC
         ${limitLine}`,
        {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          confidenceMin: confidenceMin ?? null,
          confidenceMax: confidenceMax ?? null,
          ...(scoped ? {} : { limit: BigInt(limit) }),
        },
      );


      const suggestions: SemanticEdge[] = rows.records.map((r) => {
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
          targetNodeId: targetName, // pending edge has no materialised targetNodeId
          type,
          confidence,
          source: {
            connectorId,
            sourceId: (r.get("sourceId") as string | null) ?? connectorId,
          },
          inferredAt,
          approved: false,
          approvedAt: null,
          approvedBy: null,
          // Friendly, inspectable citations — the source node resolved to its
          // real label/properties; the target described from the inferred edge
          // (not yet materialised as a node until the edge is approved).
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
            approvalStatus: "pending",
          }),
        };
      });


      // Count query (separate, cheaper than counting all via COLLECT). Carries
      // the SAME scope predicates so the total reflects only in-scope proposals.
      const countRow = await sess.run(
        `MATCH (ie:InferredEdge {orgId: $orgId, workspaceId: $workspaceId, approvalStatus: 'pending'})
         WHERE ($confidenceMin IS NULL OR ie.confidence >= $confidenceMin)
           AND ($confidenceMax IS NULL OR ie.confidence <= $confidenceMax)
           ${scopeLabelClause}
           ${scopeRelClause}
         RETURN count(ie) AS total`,
        {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
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
      // Observability (spec §5): proposals were filtered to the agent's scope.
      scopeApplied: scoped,
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

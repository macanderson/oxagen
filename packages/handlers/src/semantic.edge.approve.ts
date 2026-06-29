import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeApprove } from "@oxagen/oxagen/contracts/semantic.edge.approve";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { sanitizeRelationshipType, sanitizeLabel } from "@oxagen/ontology/labels";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";

/**
 * semantic.edge.approve handler.
 *
 * Approve or reject an InferredEdge candidate.
 *
 * On APPROVE:
 *   - Updates InferredEdge.approvalStatus = "approved", sets approvedBy + approvedAt.
 *   - Finds or creates the target KnowledgeNode (MERGE on orgId+workspaceId+type+name).
 *   - Creates a permanent relationship from the source EntityNode to the target,
 *     typed by the inferred relationship kind itself (e.g. :IMPLEMENTS, :DEPENDS_ON)
 *     so the graph reads descriptively — never a generic :SEMANTIC_EDGE label. The
 *     inferred origin is recorded as the `inferred` / `origin` properties on the
 *     relationship, not as its type. Relationship types cannot be parameterized in
 *     Cypher, so the type is sanitized via `sanitizeRelationshipType` and
 *     interpolated.
 *   - Returns the Neo4j element-id of the created relationship.
 *
 * On REJECT:
 *   - Updates InferredEdge.approvalStatus = "rejected" — never deleted (audit trail).
 *   - Attaches the optional comment for the audit record.
 *   - Returns without creating any relationship.
 */
export const semanticEdgeApproveHandler: CapabilityHandler<typeof semanticEdgeApprove> = async (
  input,
  ctx,
) => {
  const { edgeId, decision, comment } = input;
  const approvedAt = new Date().toISOString();
  const approvedBy = ctx.userId;

  const result = await runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, async () => {
    const sess = scopedSession();
    try {
      // 1. Verify the InferredEdge exists and belongs to this workspace.
      const findRow = await sess.run(
        `MATCH (ie:InferredEdge {id: $edgeId, orgId: $orgId, workspaceId: $workspaceId})
         RETURN
           ie.id               AS id,
           ie.sourceNodeId     AS sourceNodeId,
           ie.targetType       AS targetType,
           ie.targetName       AS targetName,
           ie.relationshipType AS relationshipType,
           ie.confidence       AS confidence,
           ie.approvalStatus   AS approvalStatus`,
        { edgeId },
      );

      if (findRow.records.length === 0) {
        throw new HTTPException(404, { message: `InferredEdge not found: ${edgeId}` });
      }

       
      const record = findRow.records[0]!;
      const sourceNodeId = record.get("sourceNodeId") as string;
      const targetType = record.get("targetType") as string;
      const targetName = record.get("targetName") as string;
      const relationshipType = record.get("relationshipType") as string;
      const confidence = Number(record.get("confidence"));
      const currentStatus = record.get("approvalStatus") as string;
       

      // Allow re-decision only on pending edges to prevent double-approve.
      if (currentStatus !== "pending") {
        throw new HTTPException(409, {
          message: `InferredEdge ${edgeId} is already ${currentStatus} and cannot be re-decided`,
        });
      }

      const newStatus = decision === "approve" ? "approved" : "rejected";

      // 2. Update the InferredEdge node.
      await sess.run(
        `MATCH (ie:InferredEdge {id: $edgeId, orgId: $orgId})
         SET ie.approvalStatus = $newStatus,
             ie.approvedBy     = $approvedBy,
             ie.approvedAt     = datetime($approvedAt),
             ie.comment        = $comment`,
        {
          edgeId,
          newStatus,
          approvedBy: approvedBy ?? "unknown",
          approvedAt,
          comment: comment ?? null,
        },
      );

      if (decision === "reject") {
        logger.info({ edgeId, orgId: ctx.orgId, decision: "reject" }, "semantic.edge.approve: rejected");
        return { edgeId, decision: "reject" as const, permanentEdgeId: undefined };
      }

      // 3. Approval path: materialise a permanent relationship typed by the
      //    inferred relationship kind itself (e.g. :IMPLEMENTS), so the graph
      //    reads descriptively instead of every inferred edge collapsing to a
      //    generic :SEMANTIC_EDGE. Relationship types cannot be parameterized in
      //    Cypher, so sanitize + interpolate (`relType` is guaranteed safe to
      //    place in a type position). The inferred origin lives on `r.inferred` /
      //    `r.origin`; `r.type` keeps the raw, pre-sanitization model output.
      //    MERGE on the target KnowledgeNode first, then MERGE the relationship.
      const relType = sanitizeRelationshipType(relationshipType);
      // The materialised target carries a DESCRIPTIVE PascalCase domain label
      // (e.g. :Feature, :Service) so an inferred node reads like any other graph
      // node — never an anchor-only :GraphNode and never a system-oriented marker.
      // sanitizeLabel makes it injection-safe; applied idempotently (re-adding a
      // label a node already has is a no-op) so it lands on pre-existing
      // placeholders too. `tgt.label` mirrors it as the PascalCase display chip.
      const tgtDomainLabel = sanitizeLabel(targetType);
      const tgtLabelClause = tgtDomainLabel
        ? `SET tgt:${tgtDomainLabel}\n         WITH src, tgt\n         `
        : "";
      const relResult = await sess.run(
        `MATCH (src:EntityNode {publicId: $sourceNodeId, orgId: $orgId})
         MERGE (tgt:GraphNode {
           orgId: $orgId,
           workspaceId: $workspaceId,
           type: $targetType,
           name: $targetName
         })
         ON CREATE SET
           tgt.id          = randomUUID(),
           tgt.publicId    = randomUUID(),
           tgt.label       = $targetDisplayLabel,
           tgt.displayName = $targetName,
           tgt.is_system   = false,
           tgt.createdAt   = datetime()
         WITH src, tgt
         ${tgtLabelClause}MERGE (src)-[r:${relType} {inferredEdgeId: $edgeId}]->(tgt)
         ON CREATE SET
           r.inferred    = true,
           r.origin      = 'semantic',
           r.type        = $relationshipType,
           r.confidence  = $confidence,
           r.approvedBy  = $approvedBy,
           r.approvedAt  = datetime($approvedAt),
           r.is_system   = false,
           r.createdAt   = datetime()
         RETURN elementId(r) AS relId`,
        {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          sourceNodeId,
          targetType,
          targetDisplayLabel: tgtDomainLabel ?? targetType,
          targetName,
          edgeId,
          relationshipType,
          confidence,
          approvedBy: approvedBy ?? "unknown",
          approvedAt,
        },
      );

       
      const permanentEdgeId = relResult.records[0]?.get("relId") as string | undefined;
       

      logger.info(
        { edgeId, permanentEdgeId, orgId: ctx.orgId, decision: "approve" },
        "semantic.edge.approve: approved — permanent edge created",
      );

      return { edgeId, decision: "approve" as const, permanentEdgeId };
    } finally {
      await sess.close();
    }
  });

  return result;
};

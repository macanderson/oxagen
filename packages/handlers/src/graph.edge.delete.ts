import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphEdgeDelete } from "@oxagen/oxagen/contracts/graph.edge.delete";
import { RELATIONSHIP_TYPE_PATTERN } from "@oxagen/oxagen/contracts/graph.relationship.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { emitGraphDeletionTelemetry } from "./graph.telemetry";
import { logger } from "./logger";

// The fixed GRAPH_EDGE_TYPES enum is GONE (Workspace Schema Registry §3.2): the
// relationship type is now any workspace-defined string. The DELETE template is
// built dynamically — but ONLY after the type is re-asserted against the
// always-on lexical RELATIONSHIP_TYPE_PATTERN guard (`^[A-Z][A-Z0-9_]{0,62}$`),
// which permits no backticks, brackets, whitespace, or Cypher metacharacters,
// so a type that passes is safe to interpolate. (The contract already rejects
// non-conforming types; this is defense-in-depth.)
//
// Both endpoints are scoped by BOTH orgId AND workspaceId (tenant isolation §0).
function buildDeleteQuery(relationshipType: string): string {
  if (!RELATIONSHIP_TYPE_PATTERN.test(relationshipType)) {
    throw new Error(
      `graph.edge.delete: relationship type "${relationshipType}" fails the lexical guard`,
    );
  }
  return `MATCH (from:GraphNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})-[r:${relationshipType}]->(to:GraphNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
          WITH r, count(r) AS found
          DELETE r
          RETURN found > 0 AS wasDeleted`;
}

export const graphEdgeDeleteHandler: CapabilityHandler<typeof graphEdgeDelete> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  const startedAt = Date.now();

  const query = buildDeleteQuery(input.edgeType);

  let deleted = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(query, {
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        orgId,
        workspaceId,
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
    "graph.edge.delete: relationship deletion attempted",
  );

  // Destructive op — emit a ClickHouse tool-invocation row via the shared
  // @oxagen/telemetry seam. Fire-and-forget so the response is never blocked
  // or failed by telemetry latency.
  emitGraphDeletionTelemetry(
    { orgId, workspaceId, surface: ctx.surface, messageId: ctx.messageId },
    {
      capability: graphEdgeDelete.name,
      latencyMs: Date.now() - startedAt,
      succeeded: deleted,
    },
  );

  return { deleted };
};

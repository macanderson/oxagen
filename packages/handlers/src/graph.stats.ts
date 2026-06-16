import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphStats } from "@oxagen/oxagen/contracts/graph.stats";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

export const graphStatsHandler: CapabilityHandler<typeof graphStats> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  let nodeCount = 0;
  let edgeCount = 0;
  let inferredEdgeCount = 0;
  let sourceCount = 0;
  let lastModifiedAt: string = new Date(0).toISOString();
  let nodesByLabel: Record<string, number> | undefined;
  let edgesByType: Record<string, number> | undefined;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // All aggregates are scoped by BOTH orgId AND workspaceId so counts never
      // bleed across workspaces in the same org (tenant isolation, §0). Edges
      // are scoped via both endpoint nodes — relationship properties are not
      // independently tenant-tagged, but both endpoints carry the workspace.
      // Pure Cypher only (no APOC) so this runs on any Neo4j deployment.
      const counts = await session.run(
        `MATCH (n:KnowledgeNode)
         WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
         RETURN count(n) AS nodeCount,
                count(DISTINCT n.sourceId) AS sourceCount`,
        { orgId, workspaceId },
      );
      const countRec = counts.records[0];
      nodeCount = toNumber(countRec?.get("nodeCount"));
      sourceCount = toNumber(countRec?.get("sourceCount"));

      // Edge counts: total, and inferred subset (r.inferred = true is set by
      // semantic.edge.infer). lastModifiedAt is the most recent node/edge touch.
      const edgeResult = await session.run(
        `MATCH (n:KnowledgeNode)-[r]->(m:KnowledgeNode)
         WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
           AND m.orgId = $orgId AND m.workspaceId = $workspaceId
         RETURN count(r) AS edgeCount,
                count(CASE WHEN r.inferred = true THEN 1 END) AS inferredEdgeCount`,
        { orgId, workspaceId },
      );
      const edgeRec = edgeResult.records[0];
      edgeCount = toNumber(edgeRec?.get("edgeCount"));
      inferredEdgeCount = toNumber(edgeRec?.get("inferredEdgeCount"));

      const modifiedResult = await session.run(
        `MATCH (n:KnowledgeNode)
         WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
         RETURN max(coalesce(n.updatedAt, n.createdAt)) AS lastModifiedAt`,
        { orgId, workspaceId },
      );
      const modified = modifiedResult.records[0]?.get("lastModifiedAt") as unknown;
      if (modified != null) {
        lastModifiedAt = String(modified);
      }

      if (input.includeByType) {
        const byLabelResult = await session.run(
          `MATCH (n:KnowledgeNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
           RETURN n.label AS label, count(n) AS count`,
          { orgId, workspaceId },
        );
        nodesByLabel = {};
        for (const record of byLabelResult.records) {
          const label = record.get("label") as string | null;
          if (label != null) nodesByLabel[label] = toNumber(record.get("count"));
        }

        const byTypeResult = await session.run(
          `MATCH (n:KnowledgeNode)-[r]->(m:KnowledgeNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND m.orgId = $orgId AND m.workspaceId = $workspaceId
           RETURN type(r) AS edgeType, count(r) AS count`,
          { orgId, workspaceId },
        );
        edgesByType = {};
        for (const record of byTypeResult.records) {
          const edgeType = record.get("edgeType") as string | null;
          if (edgeType != null) edgesByType[edgeType] = toNumber(record.get("count"));
        }
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    {
      nodeCount,
      edgeCount,
      inferredEdgeCount,
      sourceCount,
      includeByType: input.includeByType,
      orgId,
      workspaceId,
    },
    "graph.stats: computed graph statistics",
  );

  return {
    nodeCount,
    edgeCount,
    inferredEdgeCount,
    sourceCount,
    nodesByLabel,
    edgesByType,
    lastModifiedAt,
  };
};

/**
 * Normalise Neo4j integer columns (plain number, bigint, or {low, high}) to a
 * JS number.
 */
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

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
      // These independent reads run SEQUENTIALLY on the one scoped session, NOT
      // via Promise.all(). scopedSession() hands back a single Neo4j session, and
      // a session can only have one query (auto-commit transaction) in flight at a
      // time — firing several session.run() calls concurrently throws Neo4jError
      // "Queries cannot be run directly on a session with an open transaction"
      // (the regression #303 introduced when it "parallelised" these). True
      // parallelism would need a separate session per query; these counts are
      // cheap, so sequential reuse of one session is the correct, simpler fix.
      const results: Array<Awaited<ReturnType<typeof session.run>>> = [];
      results.push(
        await session.run(
          `MATCH (n:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
           RETURN count(n) AS nodeCount,
                  count(DISTINCT n.sourceId) AS sourceCount`,
          { orgId, workspaceId },
        ),
      );
      results.push(
        await session.run(
          `MATCH (n:GraphNode)-[r]->(m:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND m.orgId = $orgId AND m.workspaceId = $workspaceId
           RETURN count(r) AS edgeCount,
                  count(CASE WHEN r.inferred = true THEN 1 END) AS inferredEdgeCount`,
          { orgId, workspaceId },
        ),
      );
      results.push(
        await session.run(
          `MATCH (n:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
           RETURN max(coalesce(n.updatedAt, n.createdAt)) AS lastModifiedAt`,
          { orgId, workspaceId },
        ),
      );

      if (input.includeByType) {
        results.push(
          await session.run(
            `MATCH (n:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             RETURN n.label AS label, count(n) AS count`,
            { orgId, workspaceId },
          ),
        );
        results.push(
          await session.run(
            `MATCH (n:GraphNode)-[r]->(m:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
               AND m.orgId = $orgId AND m.workspaceId = $workspaceId
             RETURN type(r) AS edgeType, count(r) AS count`,
            { orgId, workspaceId },
          ),
        );
      }

      const countRec = results[0]!.records[0];
      nodeCount = toNumber(countRec?.get("nodeCount"));
      sourceCount = toNumber(countRec?.get("sourceCount"));

      const edgeRec = results[1]!.records[0];
      edgeCount = toNumber(edgeRec?.get("edgeCount"));
      inferredEdgeCount = toNumber(edgeRec?.get("inferredEdgeCount"));

      const modified = results[2]!.records[0]?.get("lastModifiedAt") as unknown;
      if (modified != null) {
        lastModifiedAt = String(modified);
      }

      if (input.includeByType && results[3] && results[4]) {
        nodesByLabel = {};
        for (const record of results[3].records) {
          const label = record.get("label") as string | null;
          if (label != null) nodesByLabel[label] = toNumber(record.get("count"));
        }

        edgesByType = {};
        for (const record of results[4].records) {
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

  const output = {
    nodeCount,
    edgeCount,
    inferredEdgeCount,
    sourceCount,
    nodesByLabel,
    edgesByType,
    lastModifiedAt,
  };

  // On the app (chat) surface, attach a render directive so the in-app agent
  // displays the stat boxes inline via the "graph-stats" chat component. API and
  // MCP consumers get the plain JSON (the optional field is simply absent).
  if (ctx.surface === "app") {
    return {
      ...output,
      render: { componentId: "graph-stats", props: { ...output } },
    };
  }

  return output;
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

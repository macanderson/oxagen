import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeSearch } from "@oxagen/oxagen/contracts/graph.node.search";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

export const graphNodeSearchHandler: CapabilityHandler<
  typeof graphNodeSearch
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  type SearchRow = {
    nodeId: string;
    label: string;
    displayName: string;
    description: string | null;
    score: number;
  };

  const rows: SearchRow[] = [];

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // Build an optional label-filter clause. We cannot use dynamic relationship
      // types here, but label filtering on a node property is safe and avoids
      // APOC or dynamic Cypher injection.
      const labelFilter =
        input.labels && input.labels.length > 0 ? "AND n.label IN $labels" : "";

      // Score: 1.0 if displayName matches, 0.5 if only description matches,
      // 0.75 if both match. This keeps ranking deterministic without full-text indexing.
      const result = await session.run(
        `MATCH (n:GraphNode)
         WHERE n.orgId = $orgId
           AND n.workspaceId = $workspaceId
           AND n.is_system = false
           AND (
                 toLower(n.displayName) CONTAINS toLower($query)
              OR toLower(coalesce(n.description, '')) CONTAINS toLower($query)
           )
           ${labelFilter}
         WITH n,
              CASE
                WHEN toLower(n.displayName) CONTAINS toLower($query)
                 AND toLower(coalesce(n.description, '')) CONTAINS toLower($query) THEN 0.75
                WHEN toLower(n.displayName) CONTAINS toLower($query) THEN 1.0
                ELSE 0.5
              END AS score
         ORDER BY score DESC, n.displayName ASC
         LIMIT $limit
         RETURN
           n.publicId    AS nodeId,
           n.label       AS label,
           n.displayName AS displayName,
           n.description AS description,
           score`,
        {
          orgId,
          workspaceId,
          query: input.query,
          labels: input.labels ?? [],
          // BigInt forces the Bolt driver to send INTEGER — plain numbers become
          // Float and Neo4j rejects them for LIMIT.
          limit: BigInt(input.limit),
        },
      );

      for (const record of result.records) {
        rows.push({
          nodeId: record.get("nodeId") as string,
          label: record.get("label") as string,
          displayName: record.get("displayName") as string,
          description: record.get("description") as string | null,
          score: record.get("score") as number,
        });
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    { query: input.query, resultCount: rows.length, orgId, workspaceId },
    "graph.node.search: search completed",
  );

  return { nodes: rows };
};

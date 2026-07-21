import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphSearch } from "@oxagen/oxagen/contracts/graph.search";
import { scopedSession } from "@oxagen/ontology/tenant";
import { oversampledLimit } from "@oxagen/ontology/ann";
import { runInTenantScope } from "@oxagen/tenancy";
import { embedText } from "@oxagen/ai";
import { logger } from "./logger";

// Build a short snippet from a JSON properties string (parse then take `content`)
// or fall back to displayName.
function buildSnippet(
  propertiesJson: string | null,
  displayName: string,
): string {
  if (propertiesJson) {
    try {
      const props = JSON.parse(propertiesJson) as Record<string, unknown>;
      if (typeof props.content === "string" && props.content.length > 0) {
        return props.content.slice(0, 240);
      }
    } catch {
      // fall through
    }
  }
  return displayName.slice(0, 240);
}

export const graphSearchHandler: CapabilityHandler<typeof graphSearch> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  // Embed the query. Telemetry mirrors the ingestion embed pattern:
  // executionStepId must be null (not a synthesized string) to satisfy the
  // ClickHouse UUID column and Postgres credit_ledger.reference_id constraints.
  const queryVector = await embedText(input.query, {
    telemetry: {
      orgId,
      workspaceId,
      surface: "app",
      executionStepId: null,
    },
  });

  type ResultRow = {
    nodeId: string;
    label: string;
    displayName: string;
    properties: string | null;
    score: number;
  };

  const rows: ResultRow[] = [];

  // k: how many to pull from the index before filtering. The tenant predicate
  // (orgId/workspaceId) is ALWAYS applied after the index call, so we must
  // over-fetch on every query — otherwise the active tenant's matches can be
  // crowded out of the global top-K by other tenants' higher-scoring nodes.
  // The optional labels predicate only adds to that attrition.
  const k = oversampledLimit(input.limit);

  // Build optional WHERE clause additions.
  const labelsClause =
    input.labels && input.labels.length > 0 ? "AND n.label IN $labels" : "";

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        `CALL db.index.vector.queryNodes('graph_node_embedding_index', $k, $queryVector)
         YIELD node AS n, score
         WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
           AND n.is_system = false
           ${labelsClause}
         RETURN n.publicId    AS nodeId,
                n.label       AS label,
                coalesce(n.displayName, n.publicId) AS displayName,
                n.properties  AS properties,
                score
         ORDER BY score DESC LIMIT $limit`,
        {
          k: BigInt(k),
          queryVector,
          labels: input.labels ?? [],
          // BigInt forces the Bolt driver to send INTEGER — plain numbers become
          // Float and Neo4j rejects them for LIMIT.
          limit: BigInt(k),
        },
      );

      for (const record of result.records) {
        rows.push({
          nodeId: record.get("nodeId") as string,
          label: record.get("label") as string,
          displayName: record.get("displayName") as string,
          properties: record.get("properties") as string | null,
          score: record.get("score") as number,
        });
      }
    } finally {
      await session.close();
    }
  });

  const results = rows.slice(0, input.limit).map((r) => ({
    nodeId: r.nodeId,
    label: r.label,
    displayName: r.displayName,
    kind: "entity" as const,
    snippet: buildSnippet(r.properties, r.displayName),
    score: r.score,
  }));

  logger.info(
    { query: input.query, resultCount: results.length, orgId, workspaceId },
    "graph.search: search completed",
  );

  return { results };
};

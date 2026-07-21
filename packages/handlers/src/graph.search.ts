import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphSearch } from "@oxagen/oxagen/contracts/graph.search";
import { scopedSession } from "@oxagen/ontology/tenant";
import {
  oversampledLimit,
  DEFAULT_OVERSAMPLE_FACTOR,
  SCOPE_OVERSAMPLE_FACTOR,
} from "@oxagen/ontology/ann";
import { runInTenantScope } from "@oxagen/tenancy";
import { embedText } from "@oxagen/ai";
import { logger } from "./logger";
import {
  effectiveGraphScope,
  nodeOnlyGraphScope,
} from "./lib/effective-graph-scope";

// Map Neo4j labels to canonical kind strings for the output.
function kindFromLabels(labels: string[]): string {
  if (labels.includes("SourceFile")) return "file";
  if (labels.includes("SourceSymbol")) return "symbol";
  if (labels.includes("SourceChunk")) return "chunk";
  if (labels.includes("Execution")) return "execution";
  if (labels.includes("GeneratedFile")) return "asset";
  if (labels.includes("AgentMemory")) return "memory";
  if (labels.includes("Document")) return "document";
  if (labels.includes("Message")) return "message";
  return "entity";
}

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
    isSystem: boolean;
    nodeLabels: string[];
    score: number;
  };

  const rows: ResultRow[] = [];

  // Agent RBAC Phase 3 (spec §3.6): a pure node search matches no
  // relationships, so only the node dimensions of the agent's effective
  // GraphScope bind (nodeOnlyGraphScope drops the rel-type allow-list —
  // vacuously satisfied here — while labels/mode/budget stay in force).
  // Humans / API-key callers carry no agentRun → undefined → byte-identical.
  const scope = nodeOnlyGraphScope(effectiveGraphScope(ctx, graphSearch.name));
  const scoped = scope !== undefined;

  // k: how many to pull from the index before filtering. The tenant predicate
  // (orgId/workspaceId) is ALWAYS applied after the index call, so we must
  // over-fetch on every query — otherwise the active tenant's matches can be
  // crowded out of the global top-K by other tenants' higher-scoring nodes.
  // The optional kinds/isSystem/labels predicates only add to that attrition —
  // and an agent scope's label allow-list is a further post-ANN filter, so a
  // scoped search doubles the over-sample factor (spec §4 Phase 3 ANN note).
  const k = oversampledLimit(
    input.limit,
    scoped ? SCOPE_OVERSAMPLE_FACTOR : DEFAULT_OVERSAMPLE_FACTOR,
  );

  // Build optional WHERE clause additions.
  const isSystemClause =
    input.isSystem !== undefined
      ? "AND coalesce(n.is_system, false) = $isSystem"
      : "";
  const labelsClause =
    input.labels && input.labels.length > 0 ? "AND n.label IN $labels" : "";
  // Post-ANN scope-label predicate (a REAL filter — the seam's bypass guard
  // requires the marker whenever the label dimension is constrained).
  const scopeLabelClause =
    scope?.labels !== undefined ? "AND n.label IN $__scopeLabels" : "";

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession(scope);
    try {
      const result = await session.run(
        `CALL db.index.vector.queryNodes('graph_node_embedding_index', $k, $queryVector)
         YIELD node AS n, score
         WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
           ${isSystemClause}
           ${labelsClause}
           ${scopeLabelClause}
         RETURN n.publicId    AS nodeId,
                n.label       AS label,
                coalesce(n.displayName, n.publicId) AS displayName,
                n.properties  AS properties,
                coalesce(n.is_system, false) AS isSystem,
                labels(n)     AS nodeLabels,
                score
         ORDER BY score DESC ${scoped ? `LIMIT ${k}` : "LIMIT $limit"}`,
        {
          k: BigInt(k),
          queryVector,
          isSystem: input.isSystem ?? null,
          labels: input.labels ?? [],
          // BigInt forces the Bolt driver to send INTEGER — plain numbers become
          // Float and Neo4j rejects them for LIMIT. The Cypher LIMIT is
          // deliberately k (not input.limit): the in-memory kind post-filter
          // below needs candidate headroom; slice(0, limit) does the final trim.
          // Under an agent scope the LIMIT must be LITERAL — the seam fails
          // closed on a parameterized LIMIT when a maxNodes budget is set (and
          // clamps the literal down to the budget).
          ...(scoped ? {} : { limit: BigInt(k) }),
        },
      );

      for (const record of result.records) {
        rows.push({
          nodeId: record.get("nodeId") as string,
          label: record.get("label") as string,
          displayName: record.get("displayName") as string,
          properties: record.get("properties") as string | null,
          isSystem: record.get("isSystem") as boolean,
          nodeLabels: record.get("nodeLabels") as string[],
          score: record.get("score") as number,
        });
      }
    } finally {
      await session.close();
    }
  });

  // Post-filter by kind if requested, then truncate to limit.
  const filtered =
    input.kinds && input.kinds.length > 0
      ? rows.filter((r) =>
          (input.kinds as string[]).includes(kindFromLabels(r.nodeLabels)),
        )
      : rows;

  const results = filtered.slice(0, input.limit).map((r) => ({
    nodeId: r.nodeId,
    label: r.label,
    displayName: r.displayName,
    kind: kindFromLabels(r.nodeLabels),
    snippet: buildSnippet(r.properties, r.displayName),
    score: r.score,
    isSystem: r.isSystem,
  }));

  logger.info(
    {
      query: input.query,
      resultCount: results.length,
      scopeApplied: scoped,
      orgId,
      workspaceId,
    },
    "graph.search: search completed",
  );

  return { results };
};

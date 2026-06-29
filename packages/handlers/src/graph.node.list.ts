import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeList } from "@oxagen/oxagen/contracts/graph.node.list";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

interface ListedNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  displayName: string;
  sourceId?: string;
  createdAt?: string;
}

export const graphNodeListHandler: CapabilityHandler<typeof graphNodeList> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  const nodes: ListedNode[] = [];
  let total = 0;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // Every filter is parameterised — never interpolated — so there is no
      // dynamic Cypher / injection surface. The optional clauses are appended
      // as static fragments gated on the presence of each input.
      //
      // Scope by BOTH orgId AND workspaceId so a node from another workspace in
      // the same org can never leak into this listing (tenant isolation, §0).
      const labelFilter =
        input.labels && input.labels.length > 0 ? "AND n.label IN $labels" : "";
      const sourceFilter = input.sourceId ? "AND n.sourceId = $sourceId" : "";
      // Ownership filter. A node written before the is_system backfill may lack the
      // property; coalesce(false) treats unflagged nodes as customer data so they
      // are never silently hidden from the default (unfiltered) view.
      const systemFilter =
        input.isSystem === undefined
          ? ""
          : input.isSystem
            ? "AND coalesce(n.is_system, false) = true"
            : "AND coalesce(n.is_system, false) = false";
      const textFilter = input.query
        ? `AND (
             toLower(n.displayName) CONTAINS toLower($query)
          OR toLower(coalesce(n.description, '')) CONTAINS toLower($query)
        )`
        : "";

      const whereClause = `WHERE n.orgId = $orgId
           AND n.workspaceId = $workspaceId
           ${labelFilter}
           ${sourceFilter}
           ${systemFilter}
           ${textFilter}`;

      const params = {
        orgId,
        workspaceId,
        labels: input.labels ?? [],
        sourceId: input.sourceId ?? null,
        query: input.query ?? "",
        // Neo4j Bolt serialises plain JS numbers as Float; SKIP/LIMIT require
        // INTEGER. Wrapping with BigInt forces the driver to send an integer
        // wire type, preventing Neo4jError "0.0 is not a valid value".
        limit: BigInt(input.limit),
        offset: BigInt(input.offset),
      };

      // Parallelize count and page queries (independent, same filter parameters)
      const [countResult, pageResult] = await Promise.all([
        session.run(
          `MATCH (n:GraphNode)
           ${whereClause}
           RETURN count(n) AS total`,
          params,
        ),
        session.run(
          // coalesce guards against nodes written without explicit display fields
          // (e.g. LLM-inferred placeholder concepts carry `type`/`name` instead of
          // `label`/`displayName`). The output contract requires non-null strings,
          // so a single such node would otherwise fail validation and blank the
          // entire explorer. Fall back type→label and name→displayName→publicId.
          `MATCH (n:GraphNode)
           ${whereClause}
           RETURN
             n.publicId                                      AS id,
             coalesce(n.label, n.type, 'Node')               AS label,
             coalesce(n.displayName, n.name, n.publicId)     AS displayName,
             n.properties                                    AS properties,
             n.sourceId                                      AS sourceId,
             n.createdAt                                     AS createdAt
           ORDER BY n.createdAt DESC, coalesce(n.displayName, n.name, n.publicId) ASC
           SKIP $offset
           LIMIT $limit`,
          params,
        ),
      ]);
      total = toNumber(countResult.records[0]?.get("total"));

      for (const record of pageResult.records) {
        const rawProperties = record.get("properties") as string | null;
        const label = record.get("label") as string;
        const sourceId = record.get("sourceId") as string | null;
        const createdAt = record.get("createdAt") as string | null;

        nodes.push({
          id: record.get("id") as string,
          // Surface both the base KnowledgeNode label and the domain label,
          // matching the documented shape (e.g. ["Issue", "KnowledgeNode"]).
          labels: ["KnowledgeNode", label],
          properties: rawProperties
            ? (JSON.parse(rawProperties) as Record<string, unknown>)
            : {},
          displayName: record.get("displayName") as string,
          ...(sourceId != null ? { sourceId } : {}),
          ...(createdAt != null ? { createdAt: String(createdAt) } : {}),
        });
      }
    } finally {
      await session.close();
    }
  });

  const hasMore = input.offset + nodes.length < total;

  logger.info(
    {
      returned: nodes.length,
      total,
      hasMore,
      labels: input.labels,
      sourceId: input.sourceId,
      query: input.query,
      orgId,
      workspaceId,
    },
    "graph.node.list: listed nodes",
  );

  return {
    nodes,
    total,
    hasMore,
    limit: input.limit,
    offset: input.offset,
  };
};

/**
 * Neo4j integer columns can arrive as a plain number or as a {low, high}
 * BigInt-style object depending on the driver's integer mode. Normalise both
 * to a JS number for the count aggregate.
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

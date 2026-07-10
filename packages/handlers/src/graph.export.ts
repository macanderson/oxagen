import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphExport } from "@oxagen/oxagen/contracts/graph.export";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";
import { safeParseProperties } from "./lib/graph-properties";

interface ExportedNode {
  id: string;
  labels: string[];
  displayName: string;
  properties: Record<string, unknown>;
  sourceId?: string;
  isSystem: boolean;
  updatedAt?: string;
}

interface ExportedEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties: Record<string, unknown>;
  inferred: boolean;
}

export const graphExportHandler: CapabilityHandler<typeof graphExport> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  const nodes: ExportedNode[] = [];
  const edges: ExportedEdge[] = [];
  let total = 0;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // Every filter is parameterised — never interpolated — so there is no
      // dynamic Cypher / injection surface. The optional clauses are appended
      // as static fragments gated on the presence of each input.
      //
      // Scope by BOTH orgId AND workspaceId so a node from another workspace
      // in the same org can never leak into this export (tenant isolation, §0).
      const labelFilter =
        input.labels && input.labels.length > 0 ? "AND n.label IN $labels" : "";

      // Ownership filter. A node written before the is_system backfill may lack
      // the property; coalesce(false) treats unflagged nodes as customer data so
      // they are never silently hidden from the default (unfiltered) view.
      const systemFilter =
        input.isSystem === undefined
          ? ""
          : input.isSystem
            ? "AND coalesce(n.is_system, false) = true"
            : "AND coalesce(n.is_system, false) = false";

      // updatedAfter is the incremental pull high-watermark. Only apply when
      // provided; the Cypher fragment is static, value is always parameterised.
      const updatedAfterFilter = input.updatedAfter
        ? "AND n.updatedAt > $updatedAfter"
        : "";

      const whereClause = `WHERE n.orgId = $orgId
           AND n.workspaceId = $workspaceId
           ${labelFilter}
           ${systemFilter}
           ${updatedAfterFilter}`;

      const params = {
        orgId,
        workspaceId,
        labels: input.labels ?? [],
        updatedAfter: input.updatedAfter ?? "",
        // Neo4j Bolt serialises plain JS numbers as Float; SKIP/LIMIT require
        // INTEGER. Wrapping with BigInt forces the driver to send an integer
        // wire type, preventing Neo4jError "0.0 is not a valid value".
        limit: BigInt(input.limit),
        offset: BigInt(input.offset),
      };

      // Count query for the same filter — drives hasMore and progress reporting.
      const countResult = await session.run(
        `MATCH (n:GraphNode)
         ${whereClause}
         RETURN count(n) AS total`,
        params,
      );
      total = toNumber(countResult.records[0]?.get("total"));

      // Page query — ordered by updatedAt ASC for cursor stability so that an
      // incremental pull (pass this page's cursor as updatedAfter) never
      // re-fetches or skips nodes. Secondary sort on publicId breaks ties so
      // the order is deterministic even when many nodes share the same timestamp.
      const pageResult = await session.run(
        // coalesce guards against nodes written without explicit display fields
        // (e.g. LLM-inferred placeholder concepts carry `type`/`name` instead
        // of `label`/`displayName`). The output contract requires non-null
        // strings, so a single such node would otherwise fail validation and
        // blank the entire page. Fall back type→label and name→displayName→publicId.
        `MATCH (n:GraphNode)
         ${whereClause}
         RETURN
           n.publicId                                      AS id,
           coalesce(n.label, n.type, 'Node')               AS label,
           coalesce(n.displayName, n.name, n.publicId)     AS displayName,
           n.properties                                    AS properties,
           n.sourceId                                      AS sourceId,
           coalesce(n.is_system, false)                    AS isSystem,
           n.updatedAt                                     AS updatedAt
         ORDER BY n.updatedAt ASC, n.publicId ASC
         SKIP $offset
         LIMIT $limit`,
        params,
      );

      for (const record of pageResult.records) {
        const id = record.get("id") as string;
        const rawProperties = record.get("properties") as unknown;
        const label = record.get("label") as string;
        const sourceId = record.get("sourceId") as string | null;
        const updatedAt = record.get("updatedAt") as string | null;
        const isSystem = record.get("isSystem") as boolean;

        nodes.push({
          id,
          // Surface the anchor label and the domain label matching the
          // documented shape (e.g. ["KnowledgeNode", "Issue"]).
          labels: ["KnowledgeNode", label],
          displayName: record.get("displayName") as string,
          // safeParseProperties never throws — one corrupt blob must not
          // reject the whole export page. Absent/unreadable → {}.
          properties: safeParseProperties(rawProperties, { nodeId: id }),
          ...(sourceId != null ? { sourceId } : {}),
          isSystem: Boolean(isSystem),
          ...(updatedAt != null ? { updatedAt: String(updatedAt) } : {}),
        });
      }

      // Edges — only when requested, restricted to the node page to keep the
      // response consistent. Both endpoints must belong to this workspace so
      // a cross-workspace edge can never leak via a shared node publicId
      // (tenant isolation enforced on BOTH sides of the relationship).
      if (input.includeEdges && nodes.length > 0) {
        const pageIds = nodes.map((n) => n.id);
        const edgeResult = await session.run(
          `MATCH (a:GraphNode)-[r]->(b:GraphNode)
           WHERE a.orgId = $orgId
             AND a.workspaceId = $workspaceId
             AND b.orgId = $orgId
             AND b.workspaceId = $workspaceId
             AND a.publicId IN $pageIds
           RETURN
             coalesce(r.publicId, toString(id(r))) AS id,
             a.publicId                             AS sourceId,
             b.publicId                             AS targetId,
             type(r)                                AS type,
             r.properties                           AS properties,
             coalesce(r.inferred, false)            AS inferred`,
          { orgId, workspaceId, pageIds },
        );

        for (const record of edgeResult.records) {
          const edgeId = String(record.get("id"));
          const rawProps = record.get("properties") as unknown;
          edges.push({
            id: edgeId,
            sourceId: record.get("sourceId") as string,
            targetId: record.get("targetId") as string,
            type: record.get("type") as string,
            properties: safeParseProperties(rawProps, { nodeId: edgeId }),
            inferred: Boolean(record.get("inferred")),
          });
        }
      }
    } finally {
      await session.close();
    }
  });

  const hasMore = input.offset + nodes.length < total;

  // cursor = max updatedAt among the returned nodes. Since the page is ordered
  // by updatedAt ASC the last non-null value is the maximum, but we scan the
  // whole page in case the trailing nodes lack the property (older data).
  // Pass this value as `updatedAfter` on the next call for incremental refresh.
  const cursor = nodes.reduce<string | null>((max, n) => {
    if (!n.updatedAt) return max;
    if (!max || n.updatedAt > max) return n.updatedAt;
    return max;
  }, null);

  logger.info(
    {
      returned: nodes.length,
      edgesReturned: edges.length,
      total,
      hasMore,
      labels: input.labels,
      isSystem: input.isSystem,
      updatedAfter: input.updatedAfter,
      includeEdges: input.includeEdges,
      cursor,
      orgId,
      workspaceId,
    },
    "graph.export: exported subgraph page",
  );

  return {
    nodes,
    edges,
    total,
    hasMore,
    limit: input.limit,
    offset: input.offset,
    cursor,
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

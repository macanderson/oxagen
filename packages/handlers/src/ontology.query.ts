import type { CapabilityHandler } from "@oxagen/oxagen";
import { ontologyQuery } from "@oxagen/oxagen/contracts/ontology.query";
import { RELATIONSHIP_TYPE_PATTERN } from "@oxagen/oxagen/lib/relationship-type-pattern";
import { scopedSession } from "@oxagen/ontology/tenant";
import {
  buildValidityFilter,
  type EdgeValidity,
} from "@oxagen/ontology/temporal";
import { runInTenantScope } from "@oxagen/tenancy";
import { getPinnedSchema } from "./schema.pinned";
import { logger } from "./logger";

interface TraversedNode {
  nodeId: string;
  label: string;
  displayName: string;
  description: string | null;
  depth: number;
}

interface TraversedEdge extends EdgeValidity {
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
}

/**
 * Resolve the relationship-type filter for the traversal (§3.2 two-layer guard).
 *
 * Returns the concrete list of relationship types to constrain the variable-length
 * pattern to, or `null` for an unconstrained traversal (no filter + no pin).
 *
 * Layer 1 — lexical guard (ALWAYS on): every type must match
 *   RELATIONSHIP_TYPE_PATTERN before it is interpolated into the Cypher pattern.
 *   Here the type IS interpolated (Cypher has no parameter form for a
 *   variable-length relationship-type pattern), so the guard is load-bearing.
 * Layer 2 — registry allow-list (when pinned): a supplied type must also be in
 *   the pinned active vocabulary; an omitted filter defaults to the active
 *   vocabulary's relationship types (NOT the old static GRAPH_EDGE_TYPES list).
 */
function resolveRelationshipTypes(
  requested: readonly string[] | undefined,
  activeVocab: readonly string[] | null,
): string[] | null {
  if (requested && requested.length > 0) {
    for (const t of requested) {
      if (!RELATIONSHIP_TYPE_PATTERN.test(t)) {
        throw new Error(
          `ontology.query: relationship type "${t}" fails the lexical guard`,
        );
      }
      if (activeVocab && !activeVocab.includes(t)) {
        throw new Error(
          `ontology.query: relationship type "${t}" is not in the pinned active vocabulary`,
        );
      }
    }
    return [...requested];
  }

  if (activeVocab) {
    return activeVocab.filter((t) => RELATIONSHIP_TYPE_PATTERN.test(t));
  }
  return null;
}

/**
 * Build the safe `:TYPE1|TYPE2` relationship-type pattern for a Cypher
 * variable-length match. Every value has already passed
 * RELATIONSHIP_TYPE_PATTERN in resolveRelationshipTypes — we re-assert here as
 * defense-in-depth so no caller path can interpolate an unguarded type. Returns
 * an empty string for an unconstrained traversal (`relTypes === null`).
 */
function relTypePattern(relTypes: string[] | null): string {
  if (relTypes === null) return "";
  for (const t of relTypes) {
    if (!RELATIONSHIP_TYPE_PATTERN.test(t)) {
      throw new Error(
        `ontology.query: relationship type "${t}" fails the lexical guard`,
      );
    }
  }
  return relTypes.map((t) => `\`${t}\``).join("|");
}

/** Compose the directional variable-length relationship pattern. */
function buildMatchPattern(
  direction: "out" | "in" | "both",
  relTypes: string,
  maxDepth: number,
): string {
  // maxDepth is validated to an integer in [1,5] by the contract — safe to inline.
  // When relTypes is empty (unconstrained), the pattern is `[r*1..n]`.
  const typeSelector = relTypes.length > 0 ? `:${relTypes}` : "";
  const variable = `[r${typeSelector}*1..${maxDepth}]`;
  switch (direction) {
    case "out":
      return `(start)-${variable}->(reached:GraphNode)`;
    case "in":
      return `(start)<-${variable}-(reached:GraphNode)`;
    case "both":
      return `(start)-${variable}-(reached:GraphNode)`;
  }
}

export const ontologyQueryHandler: CapabilityHandler<
  typeof ontologyQuery
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  // Resolve the pinned active vocabulary (null when no version is pinned), then
  // the §3.2 two-layer relationship-type guard.
  const pinned = await getPinnedSchema(orgId, workspaceId);
  const activeVocab = pinned
    ? pinned.relationshipTypes.map((r) => r.name)
    : null;
  const relTypeList = resolveRelationshipTypes(input.edgeTypes, activeVocab);
  const relTypes = relTypePattern(relTypeList);
  const matchPattern = buildMatchPattern(
    input.direction,
    relTypes,
    input.maxDepth,
  );

  let startNode: TraversedNode | null = null;
  const nodesById = new Map<string, TraversedNode>();
  const edges: TraversedEdge[] = [];
  let truncated = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // 1) Resolve the start node, scoped by BOTH orgId AND workspaceId so a
      //    same-publicId node in another workspace can never seed a traversal
      //    (tenant isolation, §0).
      const startResult = await session.run(
        `MATCH (start:GraphNode {publicId: $startNodeId, orgId: $orgId, workspaceId: $workspaceId})
         WHERE start.is_system = false
         RETURN start.publicId AS nodeId, start.label AS label,
                start.displayName AS displayName, start.description AS description`,
        { startNodeId: input.startNodeId, orgId, workspaceId },
      );
      const startRec = startResult.records[0];
      if (!startRec) {
        // Unknown start node — empty result, not an error.
        return;
      }
      startNode = {
        nodeId: startRec.get("nodeId") as string,
        label: startRec.get("label") as string,
        displayName: startRec.get("displayName") as string,
        description: startRec.get("description") as string | null,
        depth: 0,
      };
      nodesById.set(startNode.nodeId, startNode);

      // 2) Walk the graph. Every reached node and every relationship along the
      //    path is constrained to the same org + workspace. We fetch one extra
      //    row beyond `limit` to detect truncation.
      // BigInt forces the Bolt driver to send INTEGER — plain JS numbers become
      // Float and Neo4j rejects them for LIMIT.
      // Bi-temporal read filter applied to EVERY relationship on the path, so a
      // traversal only crosses edges that are valid + known at the requested
      // instants. Defaults to now/now; null lower bounds keep unstamped legacy
      // edges traversable (behaviour-preserving).
      const validity = buildValidityFilter("rel", {
        asOf: input.asOf,
        asKnownAt: input.asKnownAt,
      });

      const fetchLimit = BigInt(input.limit + 1);
      const traverseResult = await session.run(
        `MATCH (start:GraphNode {publicId: $startNodeId, orgId: $orgId, workspaceId: $workspaceId})
         MATCH path = ${matchPattern}
         WHERE reached.orgId = $orgId AND reached.workspaceId = $workspaceId
           AND reached.is_system = false
           AND ALL(n IN nodes(path) WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND n.is_system = false)
           AND ALL(rel IN relationships(path) WHERE ${validity.clause})
         WITH reached, length(path) AS depth, relationships(path) AS rels, nodes(path) AS pathNodes
         ORDER BY depth ASC
         LIMIT $fetchLimit
         RETURN
           reached.publicId    AS nodeId,
           reached.label       AS label,
           reached.displayName AS displayName,
           reached.description AS description,
           depth,
           [rel IN rels | type(rel)] AS relTypes,
           [rel IN rels | toString(rel.validFrom)]     AS relValidFrom,
           [rel IN rels | toString(rel.validTo)]       AS relValidTo,
           [rel IN rels | toString(rel.recordedAt)]    AS relRecordedAt,
           [rel IN rels | toString(rel.invalidatedAt)] AS relInvalidatedAt,
           [n IN pathNodes | n.publicId] AS pathNodeIds`,
        {
          startNodeId: input.startNodeId,
          orgId,
          workspaceId,
          fetchLimit,
          ...validity.params,
        },
      );

      let kept = 0;
      for (const record of traverseResult.records) {
        const nodeId = record.get("nodeId") as string;
        const depth = toNumber(record.get("depth"));

        if (!nodesById.has(nodeId)) {
          if (kept >= input.limit) {
            truncated = true;
            continue;
          }
          nodesById.set(nodeId, {
            nodeId,
            label: record.get("label") as string,
            displayName: record.get("displayName") as string,
            description: record.get("description") as string | null,
            depth,
          });
          kept += 1;
        }

        // Reconstruct the edges along this path. relTypes[i] connects
        // pathNodeIds[i] and pathNodeIds[i+1]; orientation follows the
        // traversal direction. The four relValidity arrays are index-aligned
        // with relTypes so each edge carries its own bi-temporal validity.
        const relTypesAlong = record.get("relTypes") as string[];
        const pathNodeIds = record.get("pathNodeIds") as string[];
        const relValidFrom =
          (record.get("relValidFrom") as (string | null)[] | null) ?? [];
        const relValidTo =
          (record.get("relValidTo") as (string | null)[] | null) ?? [];
        const relRecordedAt =
          (record.get("relRecordedAt") as (string | null)[] | null) ?? [];
        const relInvalidatedAt =
          (record.get("relInvalidatedAt") as (string | null)[] | null) ?? [];
        for (let i = 0; i < relTypesAlong.length; i += 1) {
          const a = pathNodeIds[i];
          const b = pathNodeIds[i + 1];
          const edgeType = relTypesAlong[i] as string;
          if (a == null || b == null) continue;
          const [from, to] = input.direction === "in" ? [b, a] : [a, b];
          if (
            !edges.some(
              (e) =>
                e.fromNodeId === from &&
                e.toNodeId === to &&
                e.edgeType === edgeType,
            )
          ) {
            edges.push({
              fromNodeId: from,
              toNodeId: to,
              edgeType,
              validFrom: relValidFrom[i] ?? null,
              validTo: relValidTo[i] ?? null,
              recordedAt: relRecordedAt[i] ?? null,
              invalidatedAt: relInvalidatedAt[i] ?? null,
            });
          }
        }
      }
    } finally {
      await session.close();
    }
  });

  const nodes = [...nodesById.values()];
  // Keep only edges whose endpoints survived the node cap.
  const keptIds = new Set(nodes.map((n) => n.nodeId));
  const keptEdges = edges.filter(
    (e) => keptIds.has(e.fromNodeId) && keptIds.has(e.toNodeId),
  );

  logger.info(
    {
      startNodeId: input.startNodeId,
      direction: input.direction,
      maxDepth: input.maxDepth,
      nodeCount: nodes.length,
      edgeCount: keptEdges.length,
      truncated,
      orgId,
      workspaceId,
    },
    "ontology.query: traversal completed",
  );

  return { startNode, nodes, edges: keptEdges, truncated };
};

/** Normalise Neo4j integer columns to a JS number. */
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

import type { CapabilityHandler } from "@oxagen/oxagen";
import { ontologyNeighbors } from "@oxagen/oxagen/contracts/ontology.neighbors";
import { RELATIONSHIP_TYPE_PATTERN } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import {
  buildValidityFilter,
  edgeValidityReturn,
  readEdgeValidity,
  type EdgeValidity,
} from "@oxagen/ontology/temporal";
import { runInTenantScope } from "@oxagen/tenancy";
import { getPinnedSchema } from "./schema.pinned";
import { effectiveGraphScope } from "./lib/effective-graph-scope";
import { logger } from "./logger";

interface NeighborEntry extends EdgeValidity {
  nodeId: string;
  label: string;
  displayName: string;
  description: string | null;
  edgeType: string;
  direction: "out" | "in";
  isSystem: boolean;
}

/**
 * Resolve the relationship-type allow-list for the traversal (§3.2 two-layer guard).
 *
 * Returns either:
 *  - a concrete list of relationship types to constrain the traversal to, OR
 *  - `null` meaning "do not constrain by relationship type" (unconstrained
 *    traversal — only used when the caller passed no filter AND no version is
 *    pinned, i.e. today's "all types" behavior, but injection-safe).
 *
 * Layer 1 — lexical guard (ALWAYS on): every relationship type must match
 *   RELATIONSHIP_TYPE_PATTERN before it can reach Cypher. This closes the
 *   injection vector regardless of the registry.
 * Layer 2 — registry allow-list (when pinned): a supplied type must also be a
 *   relationship type in the pinned version's ACTIVE VOCABULARY. When the filter
 *   is omitted, the default "all types" becomes the active vocabulary's
 *   relationship types — NOT the old static GRAPH_EDGE_TYPES list.
 */
function resolveRelationshipTypes(
  requested: readonly string[] | undefined,
  activeVocab: readonly string[] | null,
): string[] | null {
  // Caller supplied an explicit filter.
  if (requested && requested.length > 0) {
    for (const t of requested) {
      // Layer 1: lexical guard — reject before any Cypher interpolation.
      if (!RELATIONSHIP_TYPE_PATTERN.test(t)) {
        throw new Error(
          `ontology.neighbors: relationship type "${t}" fails the lexical guard`,
        );
      }
      // Layer 2: when a registry is pinned, the type must be in the active vocab.
      if (activeVocab && !activeVocab.includes(t)) {
        throw new Error(
          `ontology.neighbors: relationship type "${t}" is not in the pinned active vocabulary`,
        );
      }
    }
    return [...requested];
  }

  // No explicit filter: default to the pinned active vocabulary (when pinned),
  // else unconstrained traversal (null → no relationship-type filter in Cypher).
  if (activeVocab) {
    // Active-vocab names came from the registry; they still must pass the lexical
    // guard before reaching Cypher (defense-in-depth — a malformed registry row
    // can never widen the injection surface).
    return activeVocab.filter((t) => RELATIONSHIP_TYPE_PATTERN.test(t));
  }
  return null;
}

export const ontologyNeighborsHandler: CapabilityHandler<
  typeof ontologyNeighbors
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  // Resolve the pinned active vocabulary (null when no version is pinned).
  const pinned = await getPinnedSchema(orgId, workspaceId);
  const activeVocab = pinned
    ? pinned.relationshipTypes.map((r) => r.name)
    : null;
  const edgeTypes = resolveRelationshipTypes(input.edgeTypes, activeVocab);

  // Agent RBAC Phase 3 (spec §3.6): effective GraphScope = role ceiling ∩ the
  // agent's graphAccess declaration. `undefined` for humans / API-key / service
  // callers — byte-identical pass-through. When present, the traversal runs on a
  // scope-bound session and carries the reserved scope markers in REAL
  // predicates below; the seam clamps the literal LIMIT to the budget's maxNodes
  // and rejects writes under a read-mode ceiling.
  const scope = effectiveGraphScope(ctx, ontologyNeighbors.name);
  const scoped = scope !== undefined;

  let found = false;
  const neighbors: NeighborEntry[] = [];
  let truncated = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    // 1) Confirm the node exists in THIS org + workspace before reporting any
    //    neighbors — a same-publicId node in another workspace must never be
    //    treated as found (tenant isolation, §0). This probe MATCHes no
    //    relationship, so it runs on a tenancy-only session: the seam's
    //    per-query marker guard would reject a relationship-free query on a
    //    rel-type-constrained scope. Scope enforcement lives on the traversal,
    //    which is what actually returns out-of-scope-capable data.
    const probe = scopedSession();
    try {
      const existsResult = await probe.run(
        `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         RETURN n.publicId AS nodeId`,
        { nodeId: input.nodeId, orgId, workspaceId },
      );
      if (!existsResult.records[0]) {
        return;
      }
      found = true;
    } finally {
      await probe.close();
    }

    // Direction filter relative to the anchor node. 'both' applies no filter
    // and the CASE expression below labels each edge's actual orientation.
    const directionClause =
      input.direction === "out"
        ? "AND startNode(r) = n"
        : input.direction === "in"
          ? "AND endNode(r) = n"
          : "";

    // Relationship-type filter — `type(r) IN $edgeTypes` is a PARAMETER (never
    // concatenated), so this is safe even before the lexical guard; when
    // `edgeTypes` is null (no filter + no pin) the clause is omitted entirely
    // for an unconstrained traversal.
    const relTypeClause = edgeTypes ? "AND type(r) IN $edgeTypes" : "";

    // Agent-scope predicates — REAL WHERE filters that consume the seam's
    // reserved scope markers (never decorative), added only for a constrained
    // dimension. The neighbor node `m` must carry an allowed label; the edge `r`
    // must be an allowed type. Presence of these markers is what the seam's
    // bypass guard requires; correctness of the predicate is owned here.
    const scopeLabelClause =
      scope?.labels !== undefined
        ? "AND any(l IN labels(m) WHERE l IN $__scopeLabels)"
        : "";
    const scopeRelClause =
      scope?.relationshipTypes !== undefined
        ? "AND type(r) IN $__scopeRelTypes"
        : "";

    // Bi-temporal read filter — only edges valid + known at the requested
    // instants survive. Defaults to now/now so an unstamped legacy edge (null
    // lower bounds) and a currently-valid edge both pass unchanged.
    const validity = buildValidityFilter("r", {
      asOf: input.asOf,
      asKnownAt: input.asKnownAt,
    });

    // Fetch one extra row beyond the cap so we can flag truncation honestly.
    // Under an agent scope the LIMIT must be a LITERAL (input.limit is a
    // contract-validated integer): the seam FAILS CLOSED on a parameterized
    // `LIMIT $x` because it cannot clamp it to the budget's maxNodes. Humans
    // keep the parameterized `$fetchLimit` (BigInt forces INTEGER on the Bolt
    // wire) so their path is byte-identical.
    const fetchLimit = BigInt(input.limit + 1);
    const limitLine = scoped
      ? `LIMIT ${input.limit + 1}`
      : "LIMIT $fetchLimit";

    const session = scopedSession(scope);
    try {
      const result = await session.run(
        `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         MATCH (n)-[r]-(m:GraphNode)
         WHERE m.orgId = $orgId AND m.workspaceId = $workspaceId
           ${relTypeClause}
           ${scopeRelClause}
           ${scopeLabelClause}
           ${directionClause}
           AND ${validity.clause}
         RETURN
           m.publicId    AS nodeId,
           m.label       AS label,
           m.displayName AS displayName,
           m.description AS description,
           type(r)       AS edgeType,
           CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS direction,
           coalesce(m.is_system, false) AS isSystem,
           ${edgeValidityReturn("r")}
         ORDER BY m.displayName ASC
         ${limitLine}`,
        {
          nodeId: input.nodeId,
          orgId,
          workspaceId,
          edgeTypes,
          ...(scoped ? {} : { fetchLimit }),
          ...validity.params,
        },
      );

      for (const record of result.records) {
        if (neighbors.length >= input.limit) {
          truncated = true;
          break;
        }
        neighbors.push({
          nodeId: record.get("nodeId") as string,
          label: record.get("label") as string,
          displayName: record.get("displayName") as string,
          description: record.get("description") as string | null,
          edgeType: record.get("edgeType") as string,
          direction: record.get("direction") as "out" | "in",
          // `=== true` (not `as boolean`): a pre-backfill node row can surface
          // null here and the contract output requires a real boolean.
          isSystem: record.get("isSystem") === true,
          ...readEdgeValidity((k) => record.get(k)),
        });
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    {
      nodeId: input.nodeId,
      direction: input.direction,
      found,
      neighborCount: neighbors.length,
      truncated,
      // Observability (spec §5): a graph_query trace annotates whether an agent
      // GraphScope was injected into this read.
      scopeApplied: scoped,
      orgId,
      workspaceId,
    },
    "ontology.neighbors: neighborhood fetched",
  );

  return { nodeId: input.nodeId, found, neighbors, truncated };
};

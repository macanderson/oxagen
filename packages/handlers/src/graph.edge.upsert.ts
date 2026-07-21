import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphEdgeUpsert } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { RELATIONSHIP_TYPE_PATTERN } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import {
  edgeCloseOnSupersedeSet,
  edgeCloseParams,
  edgeOpenPredicate,
  edgeValidityOnCreateSet,
  edgeValidityOnMatchSet,
  edgeValidityParams,
} from "@oxagen/ontology/temporal";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";
import { effectiveGraphScope } from "./lib/effective-graph-scope";
import { assertProposalWithinScope } from "./lib/extend-proposal";

// graph.edge.upsert is the one-release DEPRECATION ALIAS of graph.relationship.upsert
// (Workspace Schema Registry §1.2). The fixed GRAPH_EDGE_TYPES enum is GONE (§3.2):
// the relationship type is now any workspace-defined string, validated by the
// always-on lexical RELATIONSHIP_TYPE_PATTERN guard (`^[A-Z][A-Z0-9_]{0,62}$`).
//
// Because the type can no longer be a static map key, the MERGE template is built
// dynamically — but ONLY after the type is re-asserted against the lexical guard,
// which permits no backticks, brackets, whitespace, or Cypher metacharacters. A
// type that passes the guard is therefore safe to interpolate into the relationship
// pattern (defense-in-depth: the contract already rejects non-conforming types).
// Both endpoints are scoped by BOTH orgId AND workspaceId (tenant isolation §0).
//
// Every write is bi-temporal: ON CREATE stamps validFrom (observedAt→now) +
// recordedAt=now with open upper bounds; ON MATCH re-asserts the fact (reopening a
// previously-superseded edge). See @oxagen/ontology/temporal.
function assertRelType(relationshipType: string): void {
  if (!RELATIONSHIP_TYPE_PATTERN.test(relationshipType)) {
    throw new Error(
      `graph.edge.upsert: relationship type "${relationshipType}" fails the lexical guard`,
    );
  }
}

function buildUpsertQuery(relationshipType: string): string {
  assertRelType(relationshipType);
  return `MATCH (from:GraphNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
          MATCH (to:GraphNode {publicId: $toNodeId, orgId: $orgId, workspaceId: $workspaceId})
          MERGE (from)-[r:${relationshipType}]->(to)
          ON CREATE SET r.properties = $properties, r.is_system = false, r.createdAt = datetime(), r._created = true,
                        ${edgeValidityOnCreateSet("r")}
          ON MATCH SET  r.properties = $properties, r.updatedAt = datetime(), r._created = false,
                        ${edgeValidityOnMatchSet("r")}
          RETURN r._created AS wasCreated`;
}

// Supersession (opt-in): a single-valued fact means the source may point at only
// one target via this relationship type. Close (never delete) any OTHER currently
// open edge of the same type from the source before/after the new fact lands, so
// history is preserved and only the new fact reads as currently valid.
function buildSupersedeQuery(relationshipType: string): string {
  assertRelType(relationshipType);
  return `MATCH (from:GraphNode {publicId: $fromNodeId, orgId: $orgId, workspaceId: $workspaceId})
          MATCH (from)-[old:${relationshipType}]->(other:GraphNode)
          WHERE other.publicId <> $toNodeId AND ${edgeOpenPredicate("old")}
          SET ${edgeCloseOnSupersedeSet("old")}
          RETURN count(old) AS closed`;
}

export const graphEdgeUpsertHandler: CapabilityHandler<
  typeof graphEdgeUpsert
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  // Agent RBAC Phase 3 (spec §3.6 + §6 Q3): an extend-mode agent writing a
  // relationship directly is a PROPOSAL — fail fast before the write. Both
  // endpoints are pre-existing nodes, so only the relationship-type dimension
  // (and read-mode) of the agent's effective GraphScope is enforced here; the
  // label allow-list does not apply (no node is proposed). Non-agent writes
  // carry no scope → no-op, byte-identical to before.
  const scope = effectiveGraphScope(ctx, graphEdgeUpsert.name);
  assertProposalWithinScope(
    { relationshipType: input.relationshipType },
    scope,
  );

  const query = buildUpsertQuery(input.relationshipType);

  const propertiesJson = input.properties
    ? JSON.stringify(input.properties)
    : null;
  const validity = edgeValidityParams(input.observedAt);

  let created = false;
  let superseded = 0;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // Close conflicting facts first so the new assertion is the sole open edge.
      if (input.supersede) {
        const closeResult = await session.run(
          buildSupersedeQuery(input.relationshipType),
          {
            fromNodeId: input.fromNodeId,
            toNodeId: input.toNodeId,
            orgId,
            workspaceId,
            ...edgeCloseParams(input.observedAt),
          },
        );
        superseded = Number(closeResult.records[0]?.get("closed") ?? 0);
      }

      const result = await session.run(query, {
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        orgId,
        workspaceId,
        properties: propertiesJson,
        ...validity,
      });

      const record = result.records[0];
      if (!record) {
        throw new Error(
          `graph.edge.upsert: no record returned — check that both nodes exist (fromNodeId=${input.fromNodeId}, toNodeId=${input.toNodeId})`,
        );
      }
      created = record.get("wasCreated") as boolean;
    } finally {
      await session.close();
    }
  });

  // Stable composite relationship identifier for the caller.
  const edgeId = `${input.fromNodeId}:${input.relationshipType}:${input.toNodeId}`;

  logger.info(
    {
      edgeId,
      created,
      superseded,
      relationshipType: input.relationshipType,
      orgId,
      workspaceId,
    },
    "graph.edge.upsert: relationship upserted",
  );

  return { edgeId, created, superseded };
};

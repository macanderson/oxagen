import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphSyncPush } from "@oxagen/oxagen/contracts/graph.sync.push";
import { RELATIONSHIP_TYPE_PATTERN } from "@oxagen/oxagen/contracts/graph.relationship.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { sanitizeLabel } from "@oxagen/ontology/labels";
import { edgeValidityOnCreateSet, edgeValidityParams } from "@oxagen/ontology/temporal";
import { runInTenantScope } from "@oxagen/tenancy";
import { isValidCodeEmbedding } from "@oxagen/code-graph/embed";
import { logger } from "./logger";

/**
 * graph.sync.push handler — ADR-018 slice 2 (up-sync).
 *
 * Idempotently MERGEs a batch of content-addressed code or lineage nodes
 * and edges into Neo4j, scoped by BOTH orgId AND workspaceId. Re-sending the
 * same payload (same naturalKeys) is a no-op — every MERGE is stable on the
 * key. Tombstones DETACH DELETE nodes by key.
 *
 * Implementation notes:
 *   - Nodes: single UNWIND MERGE (batch, one round-trip).
 *   - Edges: grouped by relationship type; one UNWIND MERGE per distinct type
 *     (Cypher MERGE requires a literal relationship type; it cannot be a
 *     parameter). Type is validated against the lexical guard before
 *     interpolation — no injection surface.
 *   - Tombstones: MATCH … DETACH DELETE in a single UNWIND.
 *   - Domain Neo4j labels (e.g. :SourceFile) are applied per-node after the
 *     MERGE batch (only when `sanitizeLabel` produces a valid identifier and
 *     the label is not already on the node). Applied within the same session
 *     to avoid a second round-trip.
 */
export const graphSyncPushHandler: CapabilityHandler<typeof graphSyncPush> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  let nodesUpserted = 0;
  let edgesUpserted = 0;
  let tombstoned = 0;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // ── 1. MERGE nodes ──────────────────────────────────────────────────────
      if (input.nodes.length > 0) {
        const nodeParams = input.nodes.map((n) => ({
          naturalKey: `sync:${input.source}:${n.key}`,
          // PascalCase the `label` display property so it matches the structural
          // domain label applied below (and the rest of the graph); fall back to
          // the raw label / "Node" when the type is unusable as an identifier.
          label: sanitizeLabel(n.labels[0] ?? "") ?? (n.labels[0] ?? "Node"),
          displayName: n.displayName,
          // Serialise properties as JSON string — same pattern as graph.node.upsert
          properties: n.properties ? JSON.stringify(n.properties) : null,
          // Best-effort semantic vector. Only a correctly-dimensioned (1536-d)
          // text-embedding-3-small vector is accepted — any other shape is
          // dropped to null so a wrong-dimension push never corrupts the
          // universal graph_node_embedding_index. Absent/invalid → coalesced to
          // the node's existing vector below (non-fatal, same as node.upsert).
          embedding: isValidCodeEmbedding(n.embedding) ? n.embedding : null,
        }));

        const nodeResult = await session.run(
          // MERGE key = naturalKey + orgId + workspaceId (tenant-scoped, same
          // convention as graph.node.upsert). $orgId / $workspaceId are injected
          // automatically by scopedSession().
          `UNWIND $nodes AS n
           MERGE (node:GraphNode {naturalKey: n.naturalKey, orgId: $orgId, workspaceId: $workspaceId})
           ON CREATE SET
             node.publicId    = randomUUID(),
             node.label       = n.label,
             node.displayName = n.displayName,
             node.properties  = n.properties,
             node.is_system   = true,
             node.createdAt   = datetime(),
             node.updatedAt   = datetime(),
             node._created    = true
           ON MATCH SET
             node.label       = n.label,
             node.displayName = n.displayName,
             node.properties  = n.properties,
             node.is_system   = true,
             node.updatedAt   = datetime(),
             node._created    = false
           SET
             node.embedding = coalesce(n.embedding, node.embedding),
             node.embeddingUpdatedAt = CASE WHEN n.embedding IS NULL THEN node.embeddingUpdatedAt ELSE datetime() END
           RETURN count(node) AS total`,
          { nodes: nodeParams, orgId, workspaceId },
        );

        nodesUpserted = toNumber(nodeResult.records[0]?.get("total"));

        // Apply domain Neo4j labels per node (requires dynamic Cypher — one
        // statement per distinct label, collected then executed). Only emits a
        // query when there are nodes with a sanitizable label; skipped silently
        // for nodes whose label does not produce a valid Neo4j identifier.
        const labelGroups = new Map<string, string[]>();
        for (const n of input.nodes) {
          const raw = n.labels[0];
          if (!raw) continue;
          const domainLabel = sanitizeLabel(raw);
          if (!domainLabel) continue;
          const naturalKey = `sync:${input.source}:${n.key}`;
          const group = labelGroups.get(domainLabel) ?? [];
          group.push(naturalKey);
          labelGroups.set(domainLabel, group);
        }

        for (const [domainLabel, keys] of labelGroups) {
          // domainLabel has already been validated by sanitizeLabel — it is safe
          // to interpolate into this Cypher label position.
          await session.run(
            `MATCH (n:GraphNode)
             WHERE n.naturalKey IN $keys
               AND n.orgId = $orgId
               AND n.workspaceId = $workspaceId
               AND NOT n:${domainLabel}
             SET n:${domainLabel}`,
            { keys, orgId, workspaceId },
          );
        }
      }

      // ── 2. MERGE edges (grouped by relationship type) ───────────────────────
      if (input.edges.length > 0) {
        // Group by type so we can use one UNWIND MERGE per type (Cypher
        // requires the relationship type to be a literal, not a parameter).
        const byType = new Map<string, Array<{ fromKey: string; toKey: string; props: string | null; inferred: boolean }>>();

        for (const e of input.edges) {
          const relType = e.type.toUpperCase();
          if (!RELATIONSHIP_TYPE_PATTERN.test(relType)) {
            logger.warn(
              { type: e.type, orgId, workspaceId },
              "graph.sync.push: edge type failed lexical guard — skipped",
            );
            continue;
          }
          const group = byType.get(relType) ?? [];
          group.push({
            fromKey: `sync:${input.source}:${e.sourceKey}`,
            toKey: `sync:${input.source}:${e.targetKey}`,
            props: e.properties ? JSON.stringify(e.properties) : null,
            inferred: e.inferred ?? false,
          });
          byType.set(relType, group);
        }

        for (const [relType, edges] of byType) {
          // relType has passed the lexical guard — safe to interpolate.
          const edgeResult = await session.run(
            `UNWIND $edges AS e
             MATCH (from:GraphNode {naturalKey: e.fromKey, orgId: $orgId, workspaceId: $workspaceId})
             MATCH (to:GraphNode   {naturalKey: e.toKey,   orgId: $orgId, workspaceId: $workspaceId})
             MERGE (from)-[r:${relType}]->(to)
             ON CREATE SET
               r.properties = e.props,
               r.is_system  = true,
               r.inferred   = e.inferred,
               r.createdAt  = datetime(),
               ${edgeValidityOnCreateSet("r")}
             ON MATCH SET
               r.properties = e.props,
               r.inferred   = e.inferred,
               r.updatedAt  = datetime()
             RETURN count(r) AS total`,
            { edges, orgId, workspaceId, ...edgeValidityParams() },
          );
          edgesUpserted += toNumber(edgeResult.records[0]?.get("total"));
        }
      }

      // ── 3. Tombstone deleted nodes ──────────────────────────────────────────
      if (input.tombstones && input.tombstones.length > 0) {
        const tombstoneKeys = input.tombstones.map((t) => `sync:${input.source}:${t.key}`);

        // Count matched nodes first, then DETACH DELETE them. The DELETE clause
        // makes rows invisible to RETURN, so we capture the count first via
        // collect() + FOREACH.
        const tombResult = await session.run(
          `MATCH (n:GraphNode)
           WHERE n.naturalKey IN $keys
             AND n.orgId = $orgId
             AND n.workspaceId = $workspaceId
           WITH collect(n) AS nodes, count(n) AS tombstoned
           FOREACH (n IN nodes | DETACH DELETE n)
           RETURN tombstoned`,
          { keys: tombstoneKeys, orgId, workspaceId },
        );
        tombstoned = toNumber(tombResult.records[0]?.get("tombstoned"));
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    { nodesUpserted, edgesUpserted, tombstoned, source: input.source, orgId, workspaceId },
    "graph.sync.push: sync completed",
  );

  return { nodesUpserted, edgesUpserted, tombstoned };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise Neo4j integer columns — the driver may return a plain number, a
 * JS bigint, or a `{low, high}` object depending on its integer mode.
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

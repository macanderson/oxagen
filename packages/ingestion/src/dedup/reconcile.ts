/**
 * Run Pass B for entities that ingestion wrote without it (#4148).
 *
 * When the embedder or the vector index cannot answer, `resolveEntity` writes
 * the entity as its own principal and marks it `similarityDeferredAt`. The
 * record is kept, but it may duplicate a node that already exists. The
 * embedding backfill gives the node a vector later. This module then searches
 * with that vector, the way ingestion would have, and links the node to its
 * match with an `ALIAS_OF` edge.
 *
 * Every call runs inside one workspace's tenant scope, through
 * `scopedSession()`, which injects `$orgId` and `$workspaceId`.
 *
 * The mark is the only state, so a retry is safe:
 *   - A node is reconciled once its mark is gone, linked or not.
 *   - A node that already has an `ALIAS_OF` edge has its mark cleared and gets
 *     no second edge. That covers a retry that stopped after linking and
 *     before clearing.
 *   - `createAliasEdge` merges, so the same edge is never written twice.
 */

import { scopedSession } from "@oxagen/ontology/tenant";
import { createAliasEdge } from "../mutations/upsert-entity";
import { CONFIRM_THRESHOLD } from "../types";
import { findSimilarityMatch, parseStoredProperties } from "./resolve";

/** How many marked nodes a workspace holds, and which ones to reconcile now. */
export interface DeferredSelection {
  /** Nodes that still carry the mark. */
  deferred: number;
  /**
   * Marked nodes with no vector yet. They wait for the embedding backfill and
   * are not selected, so they cannot crowd out nodes that can be reconciled.
   */
  withoutVector: number;
  /** Up to the requested limit of marked nodes with a vector, oldest first. */
  ids: string[];
}

export type ReconcileOutcome =
  /** Linked to a principal with an ALIAS_OF edge. The mark is cleared. */
  | {
      status: "linked";
      principalNodeId: string;
      confidence: number;
      tentative: boolean;
    }
  /** No candidate scored high enough. The node stays a principal, and the mark is cleared. */
  | { status: "unmatched" }
  /** The node already had an ALIAS_OF edge. The mark is cleared and no edge is added. */
  | { status: "already_linked" }
  /** The node has no vector to search with. The mark stays. */
  | { status: "no_vector" }
  /** The node is gone or carries no mark. Nothing changes. */
  | { status: "not_deferred" }
  /** The vector index refused the query. The mark stays. */
  | { status: "search_failed"; error: string };

/** A driver Integer: what a Neo4j `count()` arrives as over Bolt. */
function isDriverInteger(value: unknown): value is { toNumber: () => number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof value.toNumber === "function"
  );
}

/** A Neo4j count as a number. Anything unreadable counts 0. */
function countOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (isDriverInteger(value)) {
    const n = value.toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** A stored vector as numbers, or null when the node has none. */
function vectorOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const vector: number[] = [];
  for (const item of value) {
    if (typeof item !== "number") return null;
    vector.push(item);
  }
  return vector;
}

/**
 * Count the active workspace's marked nodes and choose up to `limit` of them
 * that have a vector, oldest mark first. A limit of zero still counts, so a
 * run can report what is left.
 */
export async function findDeferredNodes(
  limit: number,
): Promise<DeferredSelection> {
  const session = scopedSession();
  try {
    const counted = await session.run(
      /* cypher */ `
        MATCH (n:EntityNode {orgId: $orgId, workspaceId: $workspaceId})
        WHERE n.similarityDeferredAt IS NOT NULL
        RETURN count(n) AS deferred,
               count(CASE WHEN n.embedding IS NULL THEN 1 END) AS withoutVector
      `,
    );
    const row = counted.records[0];
    const deferred = countOf(row?.get("deferred"));
    const withoutVector = countOf(row?.get("withoutVector"));
    if (deferred - withoutVector <= 0 || limit <= 0) {
      return { deferred, withoutVector, ids: [] };
    }

    const listed = await session.run(
      /* cypher */ `
        MATCH (n:EntityNode {orgId: $orgId, workspaceId: $workspaceId})
        WHERE n.similarityDeferredAt IS NOT NULL
          AND n.embedding IS NOT NULL
          AND n.publicId IS NOT NULL
        RETURN n.publicId AS id
        ORDER BY n.similarityDeferredAt ASC
        LIMIT $limit
      `,
      { limit: BigInt(limit) },
    );
    const ids = listed.records.flatMap((r) => {
      const id: unknown = r.get("id");
      return typeof id === "string" ? [id] : [];
    });
    return { deferred, withoutVector, ids };
  } finally {
    await session.close();
  }
}

/** Remove the mark. The node is reconciled whether or not it was linked. */
async function clearSimilarityDeferred(
  nodeId: string,
  orgId: string,
): Promise<void> {
  const session = scopedSession();
  try {
    await session.run(
      /* cypher */ `
        MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})
        REMOVE n.similarityDeferredAt
      `,
      { nodeId, orgId },
    );
  } finally {
    await session.close();
  }
}

interface DeferredNode {
  vector: number[] | null;
  entityType: string;
  displayName?: string;
  properties: Record<string, unknown>;
  /** The node already has an outgoing ALIAS_OF edge. */
  linked: boolean;
}

/** Read a marked node, or null when it is gone or carries no mark. */
async function readDeferredNode(
  nodeId: string,
  orgId: string,
): Promise<DeferredNode | null> {
  const session = scopedSession();
  try {
    const result = await session.run(
      /* cypher */ `
        MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})
        WHERE n.similarityDeferredAt IS NOT NULL
        OPTIONAL MATCH (n)-[:ALIAS_OF]->(p:EntityNode {orgId: $orgId})
        WITH n, count(p) AS principals
        RETURN n.embedding AS embedding,
               coalesce(n.entityType, n.label) AS entityType,
               n.displayName AS displayName,
               n.properties AS properties,
               principals
      `,
      { nodeId, orgId },
    );
    const row = result.records[0];
    if (!row) return null;
    const entityType: unknown = row.get("entityType");
    const displayName: unknown = row.get("displayName");
    return {
      vector: vectorOf(row.get("embedding")),
      entityType: typeof entityType === "string" ? entityType : "",
      ...(typeof displayName === "string" ? { displayName } : {}),
      properties: parseStoredProperties(row.get("properties")),
      linked: countOf(row.get("principals")) > 0,
    };
  } finally {
    await session.close();
  }
}

/**
 * Reconcile one marked node in the active tenant scope.
 *
 * The search is ingestion's own Pass B (`findSimilarityMatch`), with two
 * differences. It leaves the node itself out, since a node always matches its
 * own vector. It keeps only principals, so two duplicates from one outage end
 * with one linked to the other and never with each linked to the other.
 *
 * A Neo4j fault on a read or a write throws, so the caller's step retries. The
 * outcomes above make that retry safe.
 */
export async function reconcileDeferredNode(
  nodeId: string,
  orgId: string,
): Promise<ReconcileOutcome> {
  const node = await readDeferredNode(nodeId, orgId);
  if (!node) return { status: "not_deferred" };

  if (node.linked) {
    await clearSimilarityDeferred(nodeId, orgId);
    return { status: "already_linked" };
  }
  if (!node.vector) return { status: "no_vector" };

  const search = await findSimilarityMatch(node, node.vector, orgId, {
    excludeNodeId: nodeId,
    principalsOnly: true,
  });
  if (!search.searched) return { status: "search_failed", error: search.error };

  if (!search.match) {
    await clearSimilarityDeferred(nodeId, orgId);
    return { status: "unmatched" };
  }

  const tentative = search.match.score < CONFIRM_THRESHOLD;
  await createAliasEdge(
    nodeId,
    search.match.nodeId,
    { confidence: search.match.score, matchReason: "name_embedding", tentative },
    orgId,
  );
  await clearSimilarityDeferred(nodeId, orgId);
  return {
    status: "linked",
    principalNodeId: search.match.nodeId,
    confidence: search.match.score,
    tentative,
  };
}

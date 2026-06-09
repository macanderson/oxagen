/**
 * Neo4j mutations for the ingestion pipeline.
 *
 * All ingested entities — GitHub PRs, Linear issues, Stripe customers, Google
 * Drive files, custom SQL rows, etc. — live 100% in Neo4j. No Postgres dual-write.
 * Credentials and connection config live in Postgres (encrypted); everything
 * else lives here.
 *
 * The SourceConnection node in Neo4j holds cursor state and health metrics.
 * Credentials are NEVER stored in Neo4j.
 */

import { scopedSession } from "@oxagen/ontology/tenant";
import { IngestionNodeLabels } from "./labels";
import type { EntityMutation } from "../types";

// ---------------------------------------------------------------------------
// Principal node upsert
// ---------------------------------------------------------------------------

/**
 * Upsert an ingested entity node in Neo4j. Uses MERGE on naturalKey so
 * re-running the same mutation (webhook replay, polling overlap) is safe.
 *
 * The node carries the full properties snapshot + ingestion metadata:
 *   - naturalKey:   stable dedup key from the connector
 *   - connectorType / connectionId: provenance
 *   - syncedAt:     last time this node was updated from source
 *
 * Embeddings are written separately in Stage 4 (upsertEmbedding).
 */
export async function upsertEntityNode(
  _mutation: EntityMutation,
  _orgId: string,
): Promise<{ nodeId: string }> {
  // TODO(ingestion): implement
  // MERGE (n:{entityType} {naturalKey: $naturalKey, orgId: $orgId})
  // ON CREATE SET n += $createProps
  // ON MATCH  SET n += $updateProps
  // RETURN n.publicId as nodeId
  throw new Error("upsertEntityNode: not yet implemented");
}

// ---------------------------------------------------------------------------
// Alias edge creation
// ---------------------------------------------------------------------------

export interface AliasEdgeProps {
  confidence: number;
  matchReason: string;
  tentative: boolean; // false once confidence >= CONFIRM_THRESHOLD or human confirms
}

/**
 * Create an ALIAS_OF edge from the alias node to the principal node.
 * Idempotent — MERGE on the edge so replay is safe.
 *
 * Cypher:
 *   MATCH (alias:{entityType} {publicId: $aliasId, orgId: $orgId})
 *   MATCH (principal:{entityType} {publicId: $principalId, orgId: $orgId})
 *   MERGE (alias)-[r:ALIAS_OF]->(principal)
 *   ON CREATE SET r.confidence = $confidence, r.matchReason = $matchReason,
 *                 r.tentative = $tentative, r.createdAt = datetime()
 *   ON MATCH  SET r.confidence = $confidence, r.tentative = $tentative,
 *                 r.updatedAt = datetime()
 */
export async function createAliasEdge(
  aliasNodeId: string,
  principalNodeId: string,
  props: AliasEdgeProps,
  orgId: string,
): Promise<void> {
  // TODO(ingestion): implement
  void aliasNodeId, principalNodeId, props, orgId;
  throw new Error("createAliasEdge: not yet implemented");
}

// ---------------------------------------------------------------------------
// Embedding storage
// ---------------------------------------------------------------------------

/**
 * Store the embedding vector on an existing Neo4j node.
 * Called after embedText() in Stage 4.
 *
 * Cypher:
 *   MATCH (n {publicId: $nodeId, orgId: $orgId})
 *   SET n.embedding = $vector,
 *       n.embeddingModel = $model,
 *       n.embeddingUpdatedAt = datetime()
 */
export async function upsertEmbedding(
  _nodeId: string,
  _vector: number[],
  _model: string,
  _orgId: string,
): Promise<void> {
  // TODO(ingestion): implement
  throw new Error("upsertEmbedding: not yet implemented");
}

// ---------------------------------------------------------------------------
// SourceConnection node (cursor + health — no credentials)
// ---------------------------------------------------------------------------

export interface SourceConnectionMeta {
  connectionId: string;
  workspaceId: string;
  connectorType: string;
  cursor: string | null;
  lastSyncAt: string;
  entityCountDelta?: number;
  healthStatus?: "healthy" | "degraded" | "stale";
}

/**
 * Upsert the SourceConnection node in Neo4j and advance the cursor.
 * Called at the end of Stage 3 after the entity node is committed.
 *
 * Credentials live in Postgres (ingestion.source_connections) — never here.
 */
export async function upsertSourceConnectionMeta(
  meta: SourceConnectionMeta,
  _orgId: string,
): Promise<void> {
  const session = scopedSession();
  try {
    await session.run(
      `MERGE (sc:${IngestionNodeLabels.SourceConnection} {id: $connectionId, orgId: $orgId})
       ON CREATE SET
         sc.workspaceId   = $workspaceId,
         sc.connectorType = $connectorType,
         sc.cursor        = $cursor,
         sc.lastSyncAt    = $lastSyncAt,
         sc.entityCount   = $entityCountDelta,
         sc.healthStatus  = $healthStatus,
         sc.createdAt     = datetime()
       ON MATCH SET
         sc.cursor        = $cursor,
         sc.lastSyncAt    = $lastSyncAt,
         sc.entityCount   = sc.entityCount + $entityCountDelta,
         sc.healthStatus  = $healthStatus,
         sc.updatedAt     = datetime()`,
      {
        connectionId: meta.connectionId,
        workspaceId: meta.workspaceId,
        connectorType: meta.connectorType,
        cursor: meta.cursor ?? null,
        lastSyncAt: meta.lastSyncAt,
        entityCountDelta: meta.entityCountDelta ?? 1,
        healthStatus: meta.healthStatus ?? "healthy",
      },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Inferred edge storage (Stage 5 output)
// ---------------------------------------------------------------------------

export interface InferredEdge {
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  confidence: number;
  properties?: Record<string, unknown>;
}

/**
 * Write inferred semantic edges from the LLM inference worker.
 * All edges are marked with { inferred: true, confidence } so they can be
 * filtered separately from directly-ingested structural edges.
 */
export async function upsertInferredEdges(edges: InferredEdge[], orgId: string): Promise<void> {
  // TODO(ingestion): implement — batch MERGE for each edge
  void edges, orgId;
  throw new Error("upsertInferredEdges: not yet implemented");
}

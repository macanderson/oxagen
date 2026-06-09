/**
 * Neo4j mutations for the ingestion pipeline.
 *
 * All ingested entity nodes live 100% in Neo4j — no Postgres dual-write.
 * The :EntityNode primary label is universal; entityType is a string property.
 * Credentials and connection config live in Postgres (encrypted).
 */

import { scopedSession } from "@oxagen/ontology/tenant";
import type { EntityMutation } from "../types";

export async function upsertEntityNode(
  _mutation: EntityMutation,
  _orgId: string,
): Promise<{ nodeId: string }> {
  // TODO(ingestion): implement
  // MERGE (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId})
  // ON CREATE SET n += $createProps, n.entityType = $entityType,
  //               n.sourceRecordType = $sourceRecordType, n.createdAt = datetime()
  // ON MATCH  SET n += $updateProps, n.syncedAt = datetime()
  // RETURN n.publicId as nodeId
  throw new Error("upsertEntityNode: not yet implemented");
}

export interface AliasEdgeProps {
  confidence: number;
  matchReason: string;
  tentative: boolean;
}

export async function createAliasEdge(
  _aliasNodeId: string,
  _principalNodeId: string,
  _props: AliasEdgeProps,
  _orgId: string,
): Promise<void> {
  // TODO(ingestion): implement
  // MATCH (alias:EntityNode {publicId: $aliasId, orgId: $orgId})
  // MATCH (principal:EntityNode {publicId: $principalId, orgId: $orgId})
  // MERGE (alias)-[r:ALIAS_OF]->(principal)
  // ON CREATE SET r += $props, r.createdAt = datetime()
  // ON MATCH  SET r.confidence = $props.confidence, r.updatedAt = datetime()
  throw new Error("createAliasEdge: not yet implemented");
}

export async function upsertEmbedding(
  _nodeId: string,
  _vector: number[],
  _model: string,
  _orgId: string,
): Promise<void> {
  // TODO(ingestion): implement
  // MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})
  // SET n.embedding = $vector, n.embeddingModel = $model,
  //     n.embeddingUpdatedAt = datetime()
  throw new Error("upsertEmbedding: not yet implemented");
}

export interface SourceConnectionMeta {
  connectionId: string;
  workspaceId: string;
  connectorType: string;
  cursor: string | null;
  lastSyncAt: string;
  entityCountDelta?: number;
  healthStatus?: "healthy" | "degraded" | "stale";
}

export async function upsertSourceConnectionMeta(
  meta: SourceConnectionMeta,
  _orgId: string,
): Promise<void> {
  const session = scopedSession();
  try {
    await session.run(
      `MERGE (sc:SourceConnection {id: $connectionId, orgId: $orgId})
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

export interface InferredEdge {
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
  confidence: number;
  properties?: Record<string, unknown>;
}

export async function upsertInferredEdges(_edges: InferredEdge[], _orgId: string): Promise<void> {
  // TODO(ingestion): implement — batch MERGE for each edge with { inferred: true, confidence }
  throw new Error("upsertInferredEdges: not yet implemented");
}

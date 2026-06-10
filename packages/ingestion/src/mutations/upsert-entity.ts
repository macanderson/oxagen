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
  mutation: EntityMutation,
  _orgId: string,
): Promise<{ nodeId: string }> {
  const session = scopedSession();
  try {
    const result = await session.run(
      `MERGE (n:EntityNode {naturalKey: $naturalKey, orgId: $orgId})
       ON CREATE SET
         n.publicId         = randomUUID(),
         n.entityType       = $entityType,
         n.sourceRecordType = $sourceRecordType,
         n.displayName      = $displayName,
         n.connectionId     = $connectionId,
         n.workspaceId      = $workspaceId,
         n.properties       = $properties,
         n.createdAt        = datetime()
       ON MATCH SET
         n.displayName      = $displayName,
         n.properties       = $properties,
         n.sourceRecordType = $sourceRecordType,
         n.syncedAt         = datetime()
       RETURN n.publicId AS nodeId`,
      {
        naturalKey: mutation.naturalKey,
        entityType: mutation.entityType,
        sourceRecordType: mutation.sourceRecordType,
        displayName: mutation.displayName ?? null,
        connectionId: mutation.connectionId,
        workspaceId: mutation.workspaceId,
        properties: JSON.stringify(mutation.properties),
      },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error(`upsertEntityNode: no record returned for naturalKey=${mutation.naturalKey}`);
    }
    return { nodeId: record.get("nodeId") as string };
  } finally {
    await session.close();
  }
}

export interface AliasEdgeProps {
  confidence: number;
  matchReason: string;
  tentative: boolean;
}

export async function createAliasEdge(
  aliasNodeId: string,
  principalNodeId: string,
  props: AliasEdgeProps,
  _orgId: string,
): Promise<void> {
  const session = scopedSession();
  try {
    await session.run(
      `MATCH (alias:EntityNode {publicId: $aliasNodeId, orgId: $orgId})
       MATCH (principal:EntityNode {publicId: $principalNodeId, orgId: $orgId})
       MERGE (alias)-[r:ALIAS_OF]->(principal)
       ON CREATE SET
         r.confidence  = $confidence,
         r.matchReason = $matchReason,
         r.tentative   = $tentative,
         r.createdAt   = datetime()
       ON MATCH SET
         r.confidence  = $confidence,
         r.updatedAt   = datetime()`,
      {
        aliasNodeId,
        principalNodeId,
        confidence: props.confidence,
        matchReason: props.matchReason,
        tentative: props.tentative,
      },
    );
  } finally {
    await session.close();
  }
}

export async function upsertEmbedding(
  nodeId: string,
  vector: number[],
  model: string,
  _orgId: string,
): Promise<void> {
  const session = scopedSession();
  try {
    await session.run(
      `MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})
       SET n.embedding          = $vector,
           n.embeddingModel     = $model,
           n.embeddingUpdatedAt = datetime()`,
      { nodeId, vector, model },
    );
  } finally {
    await session.close();
  }
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

// Allowed dynamic edge types mapped to their Cypher MERGE templates.
// The edge type selector pattern avoids APOC and keeps zero dynamic Cypher strings.
const EDGE_TYPE_QUERIES: Record<string, string> = {
  INFERRED_FROM: `MATCH (from:EntityNode {publicId: $fromNodeId, orgId: $orgId})
                  MATCH (to:EntityNode {publicId: $toNodeId, orgId: $orgId})
                  MERGE (from)-[r:INFERRED_FROM]->(to)
                  ON CREATE SET r.confidence = $confidence, r.inferred = true, r.createdAt = datetime()
                  ON MATCH SET  r.confidence = $confidence, r.updatedAt = datetime()`,
  REFERENCES:    `MATCH (from:EntityNode {publicId: $fromNodeId, orgId: $orgId})
                  MATCH (to:EntityNode {publicId: $toNodeId, orgId: $orgId})
                  MERGE (from)-[r:REFERENCES]->(to)
                  ON CREATE SET r.confidence = $confidence, r.inferred = true, r.createdAt = datetime()
                  ON MATCH SET  r.confidence = $confidence, r.updatedAt = datetime()`,
  SIMILAR_TO:    `MATCH (from:EntityNode {publicId: $fromNodeId, orgId: $orgId})
                  MATCH (to:EntityNode {publicId: $toNodeId, orgId: $orgId})
                  MERGE (from)-[r:SIMILAR_TO]->(to)
                  ON CREATE SET r.confidence = $confidence, r.inferred = true, r.createdAt = datetime()
                  ON MATCH SET  r.confidence = $confidence, r.updatedAt = datetime()`,
  PART_OF:       `MATCH (from:EntityNode {publicId: $fromNodeId, orgId: $orgId})
                  MATCH (to:EntityNode {publicId: $toNodeId, orgId: $orgId})
                  MERGE (from)-[r:PART_OF]->(to)
                  ON CREATE SET r.confidence = $confidence, r.inferred = true, r.createdAt = datetime()
                  ON MATCH SET  r.confidence = $confidence, r.updatedAt = datetime()`,
};

export async function upsertInferredEdges(edges: InferredEdge[], _orgId: string): Promise<void> {
  if (edges.length === 0) return;
  const session = scopedSession();
  try {
    for (const edge of edges) {
      const query = EDGE_TYPE_QUERIES[edge.edgeType];
      if (!query) {
        throw new Error(`upsertInferredEdges: unsupported edgeType "${edge.edgeType}". Allowed: ${Object.keys(EDGE_TYPE_QUERIES).join(", ")}`);
      }
      await session.run(query, {
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        confidence: edge.confidence,
      });
    }
  } finally {
    await session.close();
  }
}

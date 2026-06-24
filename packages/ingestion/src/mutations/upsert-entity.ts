/**
 * Neo4j mutations for the ingestion pipeline.
 *
 * Ingested nodes live 100% in Neo4j — no Postgres dual-write of the instance.
 *
 * §3.3 dual-write (Workspace Schema Registry): the MERGE now writes the REAL
 * label as the PRIMARY label (`(n:`Customer` { … })`) while transitionally
 * retaining the generic `:EntityNode` secondary label + `entityType` property
 * for back-compat. Readers prefer the real label; the §3.3 batch relabel (v2)
 * removes the secondary label later.
 *
 * §8 property-level validation: before the MERGE, when a workspace pins a schema
 * version, `validateNodeAgainstSchema` runs and the write branches on the
 * workspace `enforcement_mode` (strict / lenient / off). Conformance telemetry
 * and observed-label signals are emitted to ClickHouse (§4.9, §4.10).
 */

import { scopedSession } from "@oxagen/ontology/tenant";
import { chInsert } from "@oxagen/telemetry";
import { randomUUID } from "node:crypto";
import type { EntityMutation } from "../types";
import {
  validateNodeAgainstSchema,
  type PinnedSchema,
  type SchemaValidationResult,
} from "../validate/schema";

/** The relationship-type lexical guard (mirrors RELATIONSHIP_TYPE_PATTERN, §3.2). */
const NEO4J_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

/**
 * Options threaded from the pipeline into the node write. All optional so
 * pre-registry callers (and tests) keep working unchanged.
 */
export interface UpsertEntityOptions {
  /** The pinned active vocabulary (null/absent → validation skipped). */
  pinnedSchema?: PinnedSchema | null;
  /** Source connection for observation/conformance telemetry. */
  connectionId?: string;
  /** Connector record type for telemetry rationale. */
  sourceRecordType?: string;
}

/** Outcome of an entity-node write, carrying the §8 conformance result. */
export interface UpsertEntityResult {
  /** The node publicId, or null when a strict-mode write was rejected. */
  nodeId: string | null;
  /**
   * True when enforcement_mode='strict' and the payload was non-conformant —
   * the node was NOT written. The pipeline surfaces this as a `filtered`-style
   * rejection with reason `schema_nonconformant`.
   */
  rejected?: boolean;
  /** Rejection reason when `rejected` is true. */
  reason?: "schema_nonconformant";
  /** Conformance score (0.0–1.0) when a schema was evaluated. */
  conformanceScore?: number;
}

/**
 * Derive the first-class Neo4j label from the mutation's entityType (§3.3).
 * Falls back to the generic `EntityNode` when the entityType is not a valid
 * Neo4j label identifier, so a malformed customer type can never be
 * interpolated into Cypher.
 */
export function resolveNodeLabel(entityType: string): string {
  const trimmed = entityType.trim();
  return NEO4J_LABEL_PATTERN.test(trimmed) ? trimmed : "EntityNode";
}

export async function upsertEntityNode(
  mutation: EntityMutation,
  _orgId: string,
  opts: UpsertEntityOptions = {},
): Promise<UpsertEntityResult> {
  const pinnedSchema = opts.pinnedSchema ?? null;

  // ── §8 property-level validation (before the MERGE) ─────────────────────────
  let validation: SchemaValidationResult | null = null;
  if (pinnedSchema && pinnedSchema.enforcementMode !== "off") {
    validation = validateNodeAgainstSchema(
      { label: mutation.entityType, properties: mutation.properties },
      pinnedSchema,
    );

    if (pinnedSchema.enforcementMode === "strict" && !validation.valid) {
      // strict: DO NOT write. Emit a rejected conformance event and bail.
      await emitConformanceEvent(mutation, pinnedSchema, validation, "rejected", null, opts);
      return {
        nodeId: null,
        rejected: true,
        reason: "schema_nonconformant",
        conformanceScore: validation.conformanceScore,
      };
    }
  }

  // ── §3.3 dual-write: real label PRIMARY + :EntityNode secondary ─────────────
  const label = resolveNodeLabel(mutation.entityType);
  // The label passed NEO4J_LABEL_PATTERN above → safe to interpolate. When it is
  // already "EntityNode", don't double-apply the secondary label.
  const labelClause = label === "EntityNode" ? "`EntityNode`" : `\`${label}\`:\`EntityNode\``;

  // Conformance props are attached on lenient writes (§8). undefined when no
  // schema was evaluated, so existing nodes are not stamped spuriously.
  const conformanceScore = validation ? validation.conformanceScore : null;
  const schemaVersionId = validation ? pinnedSchema!.versionId : null;

  const session = scopedSession();
  let nodeId: string;
  try {
    const result = await session.run(
      `MERGE (n:${labelClause} {naturalKey: $naturalKey, orgId: $orgId})
       ON CREATE SET
         n.publicId         = randomUUID(),
         n.createdAt        = datetime()
       ON MATCH SET
         n.syncedAt         = datetime()
       SET
         n:KnowledgeNode,
         n.entityType       = $entityType,
         n.sourceRecordType = $sourceRecordType,
         n.label            = $label,
         n.displayName      = $displayName,
         n.connectionId     = $connectionId,
         n.sourceId         = $connectionId,
         n.workspaceId      = $workspaceId,
         n.properties       = $properties,
         n.conformanceScore = $conformanceScore,
         n.schemaVersionId  = $schemaVersionId,
         n.createdAt        = datetime()
       ON MATCH SET
         n.displayName      = $displayName,
         n.properties       = $properties,
         n.sourceRecordType = $sourceRecordType,
         n.conformanceScore = $conformanceScore,
         n.schemaVersionId  = $schemaVersionId,
         n.syncedAt         = datetime()
       RETURN n.publicId AS nodeId`,
      {
        naturalKey: mutation.naturalKey,
        entityType: mutation.entityType,
        sourceRecordType: mutation.sourceRecordType,
        // `label` is the type chip the explorer groups + filters on. Use the
        // domain entityType (e.g. "issue", "pull_request", "source_repository").
        label: mutation.entityType,
        // displayName must be non-null — the explorer renders it directly. Fall
        // back to the naturalKey so a node never shows as empty/"null".
        displayName: mutation.displayName ?? mutation.naturalKey,
        connectionId: mutation.connectionId,
        workspaceId: mutation.workspaceId,
        properties: JSON.stringify(mutation.properties),
        conformanceScore,
        schemaVersionId,
      },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error(`upsertEntityNode: no record returned for naturalKey=${mutation.naturalKey}`);
    }
    nodeId = record.get("nodeId") as string;
  } finally {
    await session.close();
  }

  // ── §4.9 observed-labels signal (every written node) ────────────────────────
  await emitObservedLabel(mutation, label, opts);

  // ── §4.10 conformance event + §8 below-floor signal (lenient writes) ────────
  if (validation && pinnedSchema) {
    const belowFloor = validation.conformanceScore < pinnedSchema.conformanceFloor;
    await emitConformanceEvent(
      mutation,
      pinnedSchema,
      validation,
      belowFloor ? "written_below_floor" : "accepted",
      nodeId,
      opts,
    );
    if (belowFloor) {
      // Best-effort low-conformance alert event (does not block the write).
      await emitConformanceLowEvent(mutation, pinnedSchema, validation, nodeId, opts);
    }
  }

  return {
    nodeId,
    conformanceScore: validation ? validation.conformanceScore : undefined,
  };
}

// ── ClickHouse emit helpers (best-effort; never fail the write) ───────────────

/**
 * Emit a `graph_observed_labels` row (§4.9). Append-only observation read by
 * `schema.recommend`. Best-effort: a telemetry failure is swallowed.
 */
async function emitObservedLabel(
  mutation: EntityMutation,
  label: string,
  opts: UpsertEntityOptions,
): Promise<void> {
  try {
    // chInsert stamps org_id/workspace_id from the active tenant scope.
    await chInsert("graph_observed_labels", [
      {
        event_id: randomUUID(),
        target_kind: "node",
        label_or_type: label,
        property_keys: Object.keys(mutation.properties),
        connection_id: opts.connectionId ?? null,
        source_record_type: opts.sourceRecordType ?? mutation.sourceRecordType ?? "",
        occurred_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // observation telemetry must never break ingestion.
  }
}

/**
 * Emit a `schema_conformance_events` row (§4.10). Best-effort.
 *
 * NOTE: description/error text originates from the registry + payload and is
 * stored as DATA only — never interpreted as instructions (§11 posture).
 */
async function emitConformanceEvent(
  mutation: EntityMutation,
  pinnedSchema: PinnedSchema,
  validation: SchemaValidationResult,
  outcome: "accepted" | "rejected" | "written_below_floor" | "pruned",
  nodeId: string | null,
  opts: UpsertEntityOptions,
): Promise<void> {
  try {
    await chInsert("schema_conformance_events", [
      {
        event_id: randomUUID(),
        version_id: pinnedSchema.versionId,
        target_kind: "node",
        node_id: nodeId,
        relationship_key: null,
        node_label: mutation.entityType,
        enforcement_mode: pinnedSchema.enforcementMode,
        outcome,
        conformance_score: validation.conformanceScore,
        missing_required: validation.missingRequired,
        type_errors: validation.errors
          .filter((e) => e.code === "type")
          .map((e) => e.message),
        connection_id: opts.connectionId ?? null,
        source_record_type: opts.sourceRecordType ?? mutation.sourceRecordType ?? "",
        occurred_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // conformance telemetry must never break ingestion.
  }
}

/**
 * Emit a low-conformance alert as a distinct `written_below_floor` marker row
 * (§8 `schema.conformance.low`). Reuses the conformance-events table with the
 * below-floor outcome so the alerting pipeline can subscribe. Best-effort.
 */
async function emitConformanceLowEvent(
  mutation: EntityMutation,
  pinnedSchema: PinnedSchema,
  validation: SchemaValidationResult,
  nodeId: string,
  opts: UpsertEntityOptions,
): Promise<void> {
  // Distinct event_id keeps the alert row separate from the primary outcome row.
  await emitConformanceEvent(mutation, pinnedSchema, validation, "written_below_floor", nodeId, opts);
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

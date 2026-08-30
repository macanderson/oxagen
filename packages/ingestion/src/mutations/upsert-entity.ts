/**
 * Neo4j mutations for the ingestion pipeline.
 *
 * Ingested nodes live 100% in Neo4j — no Postgres dual-write of the instance.
 *
 * The MERGE writes the real entity-type label as the primary label
 * (`(n:Customer { … })`) and also keeps the generic `:EntityNode` label plus
 * an `entityType` property, so any reader that only knows about `:EntityNode`
 * still finds the node. See docs/specs/workspace-schema-registry/spec.md §3.3.
 *
 * When a workspace pins a schema version, `validateNodeAgainstSchema` runs
 * before the MERGE and the write branches on the workspace's
 * `enforcement_mode` (strict / lenient / off). Conformance telemetry and
 * observed-label signals are emitted to ClickHouse. See
 * docs/specs/workspace-schema-registry/spec.md §8, §4.9, §4.10.
 */

import { scopedSession } from "@oxagen/ontology/tenant";
import { sanitizeLabel } from "@oxagen/ontology/labels";
import {
  edgeValidityOnCreateSet,
  edgeValidityParams,
} from "@oxagen/ontology/temporal";
import { chInsert, deterministicEventId } from "@oxagen/telemetry";
import { randomUUID } from "node:crypto";
import type { EntityMutation } from "../types";
import {
  validateNodeAgainstSchema,
  type PinnedSchema,
  type SchemaValidationResult,
} from "../validate/schema";

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
  /**
   * The enclosing Inngest run id (`ctx.runId`), used to build a stable
   * idempotency key for `schema_conformance_events` rows. Inngest keeps the
   * same run id across every retry of one execution, but mints a new run id
   * for the next separate trigger (e.g. tomorrow's re-sync of the same
   * entity). That lets a retried insert collapse into the same row (see
   * `emitConformanceEvent`) while a later, real re-observation still gets
   * its own row. Absent for non-Inngest callers (tests, direct calls), which
   * fall back to a fixed sentinel.
   */
  runId?: string;
}

/** Outcome of an entity-node write, carrying the schema-conformance result. */
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
  /**
   * True when this write CREATED the node (MERGE ON CREATE), false when it
   * updated an existing one (ON MATCH). Undefined on a strict rejection (no
   * write happened). Drives `node.created` vs `node.updated` automation
   * triggers downstream.
   */
  isNew?: boolean;
  /**
   * The node's properties BEFORE this write overwrote them, parsed from the
   * stored JSON string. `null` on create (there was no prior state) or when the
   * stored JSON was absent/malformed. On an update this is the pre-overwrite
   * snapshot the trigger matcher passes as `previousProperties` so
   * previous-aware operators (`changed`, etc.) can fire.
   */
  previousProperties?: Record<string, unknown> | null;
}

/**
 * Parse the pre-overwrite `n.properties` JSON string returned by the MERGE.
 * `null` on create (no prior state) or when the stored value is absent /
 * malformed / not a JSON object — never throws.
 */
function parsePreviousProperties(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Turn the mutation's entityType into a Neo4j label, in PascalCase —
 * `pull_request` and `PULL_REQUEST` both become `PullRequest`. Falls back to
 * `EntityNode` when the entityType has no usable label characters, so a
 * malformed customer type can never be interpolated into Cypher.
 */
export function resolveNodeLabel(entityType: string): string {
  return sanitizeLabel(entityType) ?? "EntityNode";
}

export async function upsertEntityNode(
  mutation: EntityMutation,
  orgId: string,
  opts: UpsertEntityOptions = {},
): Promise<UpsertEntityResult> {
  const pinnedSchema = opts.pinnedSchema ?? null;

  // ── Property-level validation against the pinned schema (before the MERGE) ──
  let validation: SchemaValidationResult | null = null;
  if (pinnedSchema && pinnedSchema.enforcementMode !== "off") {
    validation = validateNodeAgainstSchema(
      { label: mutation.entityType, properties: mutation.properties },
      pinnedSchema,
    );

    if (pinnedSchema.enforcementMode === "strict" && !validation.valid) {
      // strict: DO NOT write. Emit a rejected conformance event and bail.
      await emitConformanceEvent(
        mutation,
        pinnedSchema,
        validation,
        "rejected",
        null,
        opts,
      );
      return {
        nodeId: null,
        rejected: true,
        reason: "schema_nonconformant",
        conformanceScore: validation.conformanceScore,
      };
    }
  }

  // Real label as primary + :EntityNode secondary. `sanitizeLabel` already
  // made `label` a safe identifier, so it's safe to interpolate here.
  const label = resolveNodeLabel(mutation.entityType);
  const labelClause =
    label === "EntityNode" ? "`EntityNode`" : `\`${label}\`:\`EntityNode\``;

  // Conformance props are only set when a schema was actually evaluated, so
  // a write with no pinned schema doesn't stamp an existing node with them.
  const conformanceScore = validation ? validation.conformanceScore : null;
  const schemaVersionId = validation ? pinnedSchema!.versionId : null;

  const session = scopedSession();
  let nodeId: string;
  let isNew: boolean;
  let previousProperties: Record<string, unknown> | null;
  try {
    const result = await session.run(
      // The WITH between the MERGE branches and the main SET captures the
      // pre-overwrite state: `_isNew` (whether this MERGE created the node) and
      // `n.properties` (the OLD JSON string) are read BEFORE the SET below
      // clobbers them. `_isNew` is a scratch flag cleared (= null) by the SET so
      // it never persists on the node.
      `MERGE (n:${labelClause} {naturalKey: $naturalKey, orgId: $orgId})
       ON CREATE SET
         n.publicId         = randomUUID(),
         n.createdAt        = datetime(),
         n._isNew           = true
       ON MATCH SET
         n.syncedAt         = datetime(),
         n._isNew           = false
       WITH n, n._isNew AS isNew, n.properties AS previousProperties
       SET
         n:GraphNode,
         n.entityType       = $entityType,
         n.sourceRecordType = $sourceRecordType,
         n.label            = $label,
         n.displayName      = $displayName,
         n.connectionId     = $connectionId,
         n.sourceId         = $connectionId,
         n.workspaceId      = $workspaceId,
         n.properties       = $properties,
         n.is_system        = false,
         n.conformanceScore = $conformanceScore,
         n.schemaVersionId  = $schemaVersionId,
         n.updatedAt        = datetime(),
         n._isNew           = null
       RETURN n.publicId AS nodeId, isNew, previousProperties`,
      {
        naturalKey: mutation.naturalKey,
        orgId,
        entityType: mutation.entityType,
        sourceRecordType: mutation.sourceRecordType,
        // `label` is the PascalCase type chip the explorer groups/filters/colours
        // on (e.g. "Issue", "PullRequest", "SourceRepository"). The lowercase
        // registry slug stays on `entityType` above — the two are intentionally
        // distinct: slug for vocabulary lookup, PascalCase label for humans.
        label,
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
      throw new Error(
        `upsertEntityNode: no record returned for naturalKey=${mutation.naturalKey}`,
      );
    }
    nodeId = record.get("nodeId") as string;
    // `isNew` is a Neo4j boolean (true on CREATE, false on MATCH). Coerce
    // defensively — an absent/odd value is treated as an update (not new).
    isNew = record.get("isNew") === true;
    // `previousProperties` is the OLD JSON string (null on create). Parse it,
    // guarding against null/malformed → null.
    previousProperties = parsePreviousProperties(
      record.get("previousProperties"),
    );
  } finally {
    await session.close();
  }

  // ── Observed-labels signal (every written node) ──────────────────────────────
  await emitObservedLabel(mutation, label, opts);

  // ── Conformance event + below-floor signal (lenient writes) ─────────────────
  if (validation && pinnedSchema) {
    const belowFloor =
      validation.conformanceScore < pinnedSchema.conformanceFloor;
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
      await emitConformanceLowEvent(
        mutation,
        pinnedSchema,
        validation,
        nodeId,
        opts,
      );
    }
  }

  return {
    nodeId,
    isNew,
    previousProperties,
    conformanceScore: validation ? validation.conformanceScore : undefined,
  };
}

// ── ClickHouse emit helpers (best-effort; never fail the write) ───────────────

/**
 * Emit a `graph_observed_labels` row. Append-only observation read by
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
        source_record_type:
          opts.sourceRecordType ?? mutation.sourceRecordType ?? "",
        occurred_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // observation telemetry must never break ingestion.
  }
}

/**
 * Emit a `schema_conformance_events` row. Best-effort.
 *
 * The description/error text comes from the registry and the payload. It is
 * stored as data only — never treated as an instruction.
 *
 * `event_id` is built deterministically, not with `crypto.randomUUID()`, from
 * the enclosing Inngest run id, the mutation's natural key, the schema
 * version, the outcome, and a `role` discriminator. `upsertEntityNode` runs
 * inside a single Inngest step, so when Inngest retries that step, this
 * insert runs again with the same inputs. A deterministic id means the retry
 * re-derives the same row identity instead of minting a new one. Combined
 * with the table's ReplacingMergeTree engine, keyed on `event_id`, a retried
 * insert collapses into the original row on merge (query with FINAL) instead
 * of double-counting the conformance signal. `runId` keeps this safe for real
 * repeat observations too: Inngest keeps the same run id across retries of
 * one execution but mints a new one for the next trigger (e.g. tomorrow's
 * re-sync of the same entity), so a later, real re-observation still gets
 * its own row.
 */
async function emitConformanceEvent(
  mutation: EntityMutation,
  pinnedSchema: PinnedSchema,
  validation: SchemaValidationResult,
  outcome: "accepted" | "rejected" | "written_below_floor" | "pruned",
  nodeId: string | null,
  opts: UpsertEntityOptions,
  role: "result" | "low_alert" = "result",
): Promise<void> {
  try {
    await chInsert("schema_conformance_events", [
      {
        event_id: deterministicEventId(
          opts.runId ?? "no-inngest-run-id",
          mutation.naturalKey,
          pinnedSchema.versionId,
          outcome,
          role,
        ),
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
        source_record_type:
          opts.sourceRecordType ?? mutation.sourceRecordType ?? "",
        occurred_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // conformance telemetry must never break ingestion.
  }
}

/**
 * Emit a low-conformance alert as a distinct `written_below_floor` marker
 * row. Reuses the conformance-events table with the below-floor outcome so
 * the alerting pipeline can subscribe. Best-effort.
 */
async function emitConformanceLowEvent(
  mutation: EntityMutation,
  pinnedSchema: PinnedSchema,
  validation: SchemaValidationResult,
  nodeId: string,
  opts: UpsertEntityOptions,
): Promise<void> {
  // Distinct `role` keeps the alert row's deterministic event_id separate from
  // the primary outcome row's, even though both share outcome="written_below_floor".
  await emitConformanceEvent(
    mutation,
    pinnedSchema,
    validation,
    "written_below_floor",
    nodeId,
    opts,
    "low_alert",
  );
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
  orgId: string,
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
         r.is_system   = true,
         r.createdAt   = datetime(),
         ${edgeValidityOnCreateSet("r")}
       ON MATCH SET
         r.confidence  = $confidence,
         r.updatedAt   = datetime()`,
      {
        aliasNodeId,
        principalNodeId,
        orgId,
        confidence: props.confidence,
        matchReason: props.matchReason,
        tentative: props.tentative,
        ...edgeValidityParams(),
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
  orgId: string,
): Promise<void> {
  const session = scopedSession();
  try {
    await session.run(
      `MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})
       SET n.embedding          = $vector,
           n.embeddingModel     = $model,
           n.embeddingUpdatedAt = datetime()`,
      { nodeId, orgId, vector, model },
    );
  } finally {
    await session.close();
  }
}

/**
 * Meta-node describing a source connection in the graph.
 *
 * BOUNDARY NOTE: `cursor`, `lastSyncAt`, `healthStatus`, and `entityCount` are
 * operational state whose ACID source of truth is
 * `ingestion.source_connections` in Postgres — this node is a denormalized
 * graph-side copy for traversal, never the authority. `entityCountDelta` is
 * also a read-modify-write counter applied from an at-least-once Inngest step,
 * so a retried step double-counts; and on a node created before `entityCount`
 * existed the `sc.entityCount + $delta` below evaluates to null (Cypher null
 * arithmetic) and the count is lost for good.
 */
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
  orgId: string,
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
        orgId,
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

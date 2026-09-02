/**
 * Universal ingestion pipeline runner.
 *
 * Stages:
 *   1. Receive    RawIngestEvent arrives (webhook or poller)
 *              → record-type filter: skip if type not in deliveryConfig.recordTypeFilters
 *   2. Normalize  connector.normalizeRecord() → NormalizedRecord
 *              → path filter:  skip if record.properties.path matches deliveryConfig.pathFilters
 *              → label filter: skip if record.properties.labels matches deliveryConfig.labelFilters
 *   3. Map        ctx.getMapping() → EntityTypeMapping | null (skip if null)
 *   4. Dedup      resolveEntity() → DeduplicationResult
 *   5. Embed      embedEntity() → vector stored on :EntityNode. The
 *                 `semanticInference` flag on delivery config turns embedding
 *                 off per record type; no relationship-inference job runs.
 *
 * Filtered records (record-type / path / label) return null with a reason
 * attached so callers can emit the `pipeline:record:filtered` telemetry event.
 *
 * NOT THE PRODUCTION PATH. Nothing outside this package calls `runPipeline`.
 * Real ingestion runs through
 * `packages/inngest-functions/src/functions/ingestion.pipeline.ts`, which
 * re-implements these same five stages as durable Inngest steps. The two have
 * already drifted: this one threads `getPinnedSchema` into the write so the
 * workspace schema registry is enforced, and the Inngest one calls
 * `resolveEntity` / `upsertEntityNode` with no `pinnedSchema` at all — so
 * enforcement_mode, the conformance floor, and `schema_conformance_events` are
 * inert in production. Collapse onto one implementation.
 */

import { getConnector } from "./connectors/types";
import { resolveEntity } from "./dedup/resolve";
import { renderEntityText, embedEntity } from "./embed/index";
import {
  applyRecordTypeFilter,
  applyPathFilter,
  applyLabelFilter,
  shouldRunInference,
  type DeliveryConfig,
} from "./filters";
import type { PinnedSchema } from "./validate/schema";
import type {
  RawIngestEvent,
  EntityMutation,
  PipelineResult,
  SourceRef,
} from "./types";

export interface EntityTypeMapping {
  // Customer-configured workspace-scoped entity type string.
  oxagenEntityType: string;
  // Source field path → canonical property name.
  propertyMappings: Record<string, string>;
}

export interface PipelineContext {
  orgId: string;
  // Returns null when no mapping is configured for this (connectionId, sourceRecordType).
  // A null result means the record type is intentionally ignored — return null from runPipeline.
  getMapping(
    connectionId: string,
    sourceRecordType: string,
  ): Promise<EntityTypeMapping | null>;
  /** Optional: connector delivery config to enforce filters. */
  getDeliveryConfig?(connectionId: string): Promise<DeliveryConfig | null>;
  /**
   * Resolve the workspace's pinned schema active vocabulary. See
   * docs/specs/workspace-schema-registry/spec.md §4.8. Returns the enabled
   * schemas' labels, relationship types, and properties; null when no
   * version is pinned.
   *
   * `runPipeline` loads this once and threads it to the validation (upsert)
   * stage. Optional so callers without a pinned schema, including tests,
   * keep working without it.
   */
  getPinnedSchema?(
    orgId: string,
    workspaceId: string,
  ): Promise<PinnedSchema | null>;
}

export interface FilteredResult {
  filtered: true;
  reason: string;
  sourceRecordType: string;
  connectionId: string;
}

export async function runPipeline(
  event: RawIngestEvent,
  ctx: PipelineContext,
): Promise<PipelineResult | FilteredResult | null> {
  // Parallelize independent I/O operations: delivery config and pinned schema
  const [deliveryConfig, pinnedSchema] = await Promise.all([
    ctx.getDeliveryConfig
      ? ctx.getDeliveryConfig(event.connectionId)
      : Promise.resolve(null),
    ctx.getPinnedSchema
      ? ctx.getPinnedSchema(event.orgId, event.workspaceId)
      : Promise.resolve(null),
  ]);

  // ── Stage 1: Record type filter ───────────────────────────────────────────
  const recordTypeFilters = deliveryConfig?.recordTypeFilters ?? [];
  const typeFilter = applyRecordTypeFilter(
    event.sourceRecordType,
    recordTypeFilters,
  );
  if (typeFilter.filtered) {
    return {
      filtered: true,
      reason: typeFilter.reason ?? "record_type_not_allowed",
      sourceRecordType: event.sourceRecordType,
      connectionId: event.connectionId,
    };
  }

  // Stage 2: Normalize raw payload → flat NormalizedRecord
  const connector = getConnector(event.connectorType);
  const normalized = connector.normalizeRecord(
    event.sourceRecordType,
    event.payload,
  );

  // ── Stage 2: Path filter ──────────────────────────────────────────────────
  const pathPatterns = deliveryConfig?.pathFilters ?? [];
  const pathFilter = applyPathFilter(normalized.properties, pathPatterns);
  if (pathFilter.filtered) {
    return {
      filtered: true,
      reason: pathFilter.reason ?? "path_filtered",
      sourceRecordType: event.sourceRecordType,
      connectionId: event.connectionId,
    };
  }

  // ── Stage 2: Label filter ─────────────────────────────────────────────────
  const labelPatterns = deliveryConfig?.labelFilters ?? [];
  const labelFilter = applyLabelFilter(normalized.properties, labelPatterns);
  if (labelFilter.filtered) {
    return {
      filtered: true,
      reason: labelFilter.reason ?? "label_filtered",
      sourceRecordType: event.sourceRecordType,
      connectionId: event.connectionId,
    };
  }

  // Stage 3: Look up customer's entity type mapping for this sourceRecordType
  const mapping = await ctx.getMapping(
    event.connectionId,
    event.sourceRecordType,
  );
  if (mapping === null) return null;

  // Apply property mappings: rename source field paths to canonical property names
  const mappedProperties: Record<string, unknown> = {
    ...normalized.properties,
  };
  for (const [sourceField, canonicalName] of Object.entries(
    mapping.propertyMappings,
  )) {
    if (sourceField in mappedProperties) {
      mappedProperties[canonicalName] = mappedProperties[sourceField];
      if (canonicalName !== sourceField) delete mappedProperties[sourceField];
    }
  }

  const sourceRef: SourceRef = {
    connectorType: event.connectorType,
    connectionId: event.connectionId,
    externalId: normalized.externalId,
    externalUrl: normalized.externalUrl,
  };

  const mutation: EntityMutation = {
    workspaceId: event.workspaceId,
    orgId: event.orgId,
    connectionId: event.connectionId,
    entityType: mapping.oxagenEntityType,
    sourceRecordType: event.sourceRecordType,
    naturalKey: `${event.connectorType}:${event.connectionId}:${normalized.externalId}`,
    operation: "insert",
    displayName: normalized.displayName,
    properties: mappedProperties,
    sourceRef,
  };

  // Stage 4: Dedup + alias resolution — schema validation and the dual-write
  // both run inside upsertEntityNode with the pinned active vocabulary.
  const dedup = await resolveEntity(mutation, ctx.orgId, {
    pinnedSchema,
    connectionId: event.connectionId,
    sourceRecordType: event.sourceRecordType,
  });

  // strict-mode rejection: the node was not written — surface a filtered
  // result so the caller emits `pipeline:record:filtered` and does not embed.
  if (dedup.rejected || dedup.principalNodeId == null) {
    return {
      filtered: true,
      reason: "schema_nonconformant",
      sourceRecordType: event.sourceRecordType,
      connectionId: event.connectionId,
    };
  }

  // The guard above guarantees a written node — capture the non-null id.
  const principalNodeId = dedup.principalNodeId;

  // ── Stage 5: Embed (honor the tenant's embedding opt-out) ─────────────────
  // KNOWN GAP: on the alias branch `principalNodeId` is the pre-existing
  // principal, not the alias node this record just created. So the principal's
  // vector is overwritten with the alias's rendered text, and the alias node is
  // left with no embedding at all — which makes it invisible to every later
  // Pass-B similarity search. The alias node id is available as
  // `dedup.aliasNodeId`; deciding which of the two to embed is a dedup-design
  // question, not a local edit.
  const embeddingEnabled = shouldRunInference(
    event.sourceRecordType,
    deliveryConfig?.semanticInference,
  );

  let embedded = false;
  if (embeddingEnabled) {
    const text = renderEntityText(
      mutation.entityType,
      mutation.displayName,
      mutation.properties,
    );
    await embedEntity({
      nodeId: principalNodeId,
      entityType: mutation.entityType,
      text,
      workspaceId: mutation.workspaceId,
      orgId: mutation.orgId,
      connectionId: mutation.connectionId,
    });
    embedded = true;
  }

  return {
    naturalKey: mutation.naturalKey,
    operation: mutation.operation,
    dedup,
    embedded,
    conformanceScore: dedup.conformanceScore,
  };
}

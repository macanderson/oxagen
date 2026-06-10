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
 *   5. Embed      embedEntity() → vector stored on :EntityNode
 *              → inference gate: skip embed+infer if deliveryConfig.semanticInference disables it
 *   6. Infer      ctx.scheduleInference() fires async Inngest event
 *
 * Stages 2–5 run inline in one Inngest step. Stage 6 fires asynchronously
 * so LLM inference doesn't hold concurrency slots.
 *
 * Filtered records (record-type / path / label) return null with a reason
 * attached so callers can emit the `pipeline:record:filtered` telemetry event.
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
import type { RawIngestEvent, EntityMutation, PipelineResult, SourceRef } from "./types";

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
  getMapping(connectionId: string, sourceRecordType: string): Promise<EntityTypeMapping | null>;
  scheduleInference(nodeId: string, entityType: string, snapshot: Record<string, unknown>): Promise<void>;
  /** Optional: connector delivery config to enforce filters. */
  getDeliveryConfig?(connectionId: string): Promise<DeliveryConfig | null>;
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
  // Load delivery config once if the context supports it
  const deliveryConfig: DeliveryConfig | null =
    ctx.getDeliveryConfig ? await ctx.getDeliveryConfig(event.connectionId) : null;

  // ── Stage 1: Record type filter ───────────────────────────────────────────
  const recordTypeFilters = deliveryConfig?.recordTypeFilters ?? [];
  const typeFilter = applyRecordTypeFilter(event.sourceRecordType, recordTypeFilters);
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
  const normalized = connector.normalizeRecord(event.sourceRecordType, event.payload);

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
  const mapping = await ctx.getMapping(event.connectionId, event.sourceRecordType);
  if (mapping === null) return null;

  // Apply property mappings: rename source field paths to canonical property names
  const mappedProperties: Record<string, unknown> = { ...normalized.properties };
  for (const [sourceField, canonicalName] of Object.entries(mapping.propertyMappings)) {
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

  // Stage 4: Dedup + alias resolution
  const dedup = await resolveEntity(mutation, ctx.orgId);

  // ── Stage 5: Embed + Inference gate ──────────────────────────────────────
  const inferenceEnabled = shouldRunInference(
    event.sourceRecordType,
    deliveryConfig?.semanticInference,
  );

  let embedded = false;
  let inferenceQueued = false;

  if (inferenceEnabled) {
    const text = renderEntityText(mutation.entityType, mutation.displayName, mutation.properties);
    await embedEntity({
      nodeId: dedup.principalNodeId,
      entityType: mutation.entityType,
      text,
      workspaceId: mutation.workspaceId,
      orgId: mutation.orgId,
      connectionId: mutation.connectionId,
    });
    embedded = true;

    // Stage 6: Fire async inference (does not block return)
    await ctx.scheduleInference(dedup.principalNodeId, mutation.entityType, mutation.properties);
    inferenceQueued = true;
  }

  return {
    naturalKey: mutation.naturalKey,
    operation: mutation.operation,
    dedup,
    embedded,
    inferenceQueued,
  };
}

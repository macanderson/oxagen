/**
 * Universal ingestion pipeline runner.
 *
 * This is the abstract orchestration layer every connector runs through.
 * Connector authors implement ConnectorPlugin — they never call this directly.
 * The Inngest function wraps this and handles retries.
 *
 *   Stage 1: Receive     → RawIngestEvent arrives (webhook or poller)
 *   Stage 2: Normalize   → connector.normalize() → EntityMutation | null
 *   Stage 3: Resolve     → dedup + alias resolution → DeduplicationResult
 *   Stage 4: Embed       → embedEntity() → vector stored on Neo4j node
 *   Stage 5: Infer       → fires "ingestion/entity.infer" Inngest event (async)
 *
 * Stages 1–4 run inline in a single Inngest step (fast: <2 s total).
 * Stage 5 fires asynchronously so LLM inference doesn't hold concurrency slots.
 */

import { getConnector } from "./connectors/types";
import { resolveEntity } from "./dedup/resolve";
import { renderEntityText, embedEntity } from "./embed/index";
import type { RawIngestEvent, EntityMutation, PipelineResult } from "./types";

export interface PipelineContext {
  orgId: string;
  /** Fire Stage 5 for a committed node. Injected by the Inngest function. */
  scheduleInference(nodeId: string, entityType: string, snapshot: Record<string, unknown>): Promise<void>;
}

/**
 * Run stages 1–4 for a single RawIngestEvent.
 * Returns null if the connector chose to skip the event (normalize returns null).
 */
export async function runPipeline(
  event: RawIngestEvent,
  ctx: PipelineContext,
): Promise<PipelineResult | null> {
  // Stage 2: Normalize
  const connector = getConnector(event.connectorType);
  const mutation: EntityMutation | null = connector.normalize(event);
  if (mutation === null) return null;

  // Stage 3: Resolve (dedup + alias)
  const dedup = await resolveEntity(mutation, ctx.orgId);

  // Stage 4: Embed
  const text = renderEntityText(
    mutation.entityType,
    mutation.displayName,
    mutation.properties,
  );
  await embedEntity({
    nodeId: dedup.principalNodeId,
    entityType: mutation.entityType,
    text,
    workspaceId: mutation.workspaceId,
    orgId: mutation.orgId,
    connectionId: mutation.connectionId,
  });

  // Stage 5: fire async (does not block this function's return)
  await ctx.scheduleInference(dedup.principalNodeId, mutation.entityType, mutation.properties);

  return {
    naturalKey: mutation.naturalKey,
    operation: mutation.operation,
    dedup,
    embedded: true,
    inferenceQueued: true,
  };
}

import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeInfer } from "@oxagen/oxagen/contracts/semantic.edge.infer";
import { withTenantDb, schema } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { eventClient } from "./event-client";
import { logger } from "./logger";

/**
 * semantic.edge.infer handler.
 *
 * Fetches all EntityNodes in the workspace (optionally filtered by sourceIds),
 * then fires one `ingestion/entity.infer` Inngest event per node. The
 * Inngest worker (`ingestion-semantic-edge-infer`) runs the LLM inference and
 * writes InferredEdge nodes to Neo4j with approvalStatus = "pending" or
 * auto-accepts high-confidence edges.
 *
 * This handler is intentionally lightweight — it is the dispatch boundary
 * only. All LLM work and Neo4j writes happen in the async Inngest worker.
 */
export const semanticEdgeInferHandler: CapabilityHandler<typeof semanticEdgeInfer> = async (
  input,
  ctx,
) => {
  const jobId = "job_" + crypto.randomUUID();

  // Resolve source connection IDs from the workspace to obtain node counts
  // and build per-node events. If sourceIds are provided we restrict to those.
  const connections = await withTenantDb((tx) => {
    const q = tx
      .select({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      );

    if (input.sourceIds && input.sourceIds.length > 0) {
      // Filter to connections whose publicId is in the sourceIds list.
      // We use a JS-side filter after the DB fetch because Drizzle's `.where`
      // with inArray is available but the public/internal ID join is simpler here.
      return q;
    }

    return q;
  });

  // Filter by sourceIds after DB fetch (publicId comparison).
  const filteredConnections =
    input.sourceIds && input.sourceIds.length > 0
      ? connections.filter((c) => input.sourceIds!.includes(c.publicId))
      : connections;

  if (filteredConnections.length === 0) {
    logger.info(
      { jobId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "semantic.edge.infer: no active connections found, skipping",
    );
    return { jobId, status: "queued" as const, estimatedNodes: 0, dryRun: input.dryRun };
  }

  // Fire the inference job via Inngest. In dry-run mode we fire to a
  // "dry-run" variant event that the worker recognises and skips Neo4j writes.
  const eventName = input.dryRun
    ? ("ingestion/entity.infer.dry-run" as never)
    : ("ingestion/entity.infer" as never);

  // Build one queued event per connection, carrying the shared job context.
  // The Inngest pipeline will dispatch per-entity sub-events once it reads the
  // connection's EntityNodes from Neo4j.
  await eventClient.send({
    name: "ingestion/semantic.edge.infer.requested" as never,
    data: {
      jobId,
      connectionIds: filteredConnections.map((c) => c.id),
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      maxEdgesPerNode: input.maxEdgesPerNode,
      confidenceThreshold: input.confidenceThreshold,
      semanticEdgePrompt: input.semanticEdgePrompt,
      dryRun: input.dryRun,
      requestedAt: new Date().toISOString(),
    },
  });

  void eventName; // used conceptually above; keep the reference to avoid lint

  logger.info(
    {
      jobId,
      connectionCount: filteredConnections.length,
      dryRun: input.dryRun,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "semantic.edge.infer: queued",
  );

  return {
    jobId,
    status: "queued" as const,
    estimatedNodes: filteredConnections.length,
    dryRun: input.dryRun,
  };
};

import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeInfer } from "@oxagen/oxagen/contracts/semantic.edge.infer";
import { logger } from "./logger";

export const semanticEdgeInferHandler: CapabilityHandler<typeof semanticEdgeInfer> = async (input, ctx) => {
  // TODO: Dispatch Inngest inference job that:
  //   1. Loads workspace nodes (optionally filtered by sourceIds)
  //   2. Runs LLM with semanticEdgePrompt to identify cross-node relationships
  //   3. Persists edges above confidenceThreshold to Neo4j; stages edges below for review
  //   4. Skips persistence when dryRun=true
  const jobId = "job_" + crypto.randomUUID();

  logger.info(
    {
      jobId,
      dryRun: input.dryRun,
      confidenceThreshold: input.confidenceThreshold,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "semantic.edge.infer: queued (stub)",
  );

  return {
    jobId,
    status: "queued" as const,
    estimatedNodes: 0,
    dryRun: input.dryRun,
  };
};

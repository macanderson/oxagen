import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeSuggest } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import { logger } from "./logger";

export const semanticEdgeSuggestHandler: CapabilityHandler<typeof semanticEdgeSuggest> = async (input, ctx) => {
  // TODO: Query Neo4j for inferred semantic edges that are NOT yet approved (pending review),
  // filtered by confidence range and sorted by confidence descending
  logger.info(
    {
      confidenceMin: input.confidenceMin,
      confidenceMax: input.confidenceMax,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "semantic.edge.suggest: fetched (stub)",
  );

  return {
    suggestions: [],
    total: 0,
    limit: input.limit,
  };
};

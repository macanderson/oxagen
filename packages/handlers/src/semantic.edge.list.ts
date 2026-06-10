import type { CapabilityHandler } from "@oxagen/oxagen";
import { semanticEdgeList } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { logger } from "./logger";

export const semanticEdgeListHandler: CapabilityHandler<typeof semanticEdgeList> = async (input, ctx) => {
  // TODO: Query Neo4j for inferred semantic edges scoped to workspace, applying
  // type/sourceId/confidence range filters and pagination
  logger.info(
    {
      type: input.type,
      sourceId: input.sourceId,
      confidenceMin: input.confidenceMin,
      confidenceMax: input.confidenceMax,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "semantic.edge.list: fetched (stub)",
  );

  return {
    edges: [],
    total: 0,
    limit: input.limit,
    offset: input.offset,
  };
};

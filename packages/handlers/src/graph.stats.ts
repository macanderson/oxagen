import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphStats } from "@oxagen/oxagen/contracts/graph.stats";
import { logger } from "./logger";

export const graphStatsHandler: CapabilityHandler<typeof graphStats> = async (input, ctx) => {
  // TODO: Run aggregation queries in Neo4j for the workspace:
  //   - COUNT(n) WHERE n.workspaceId = $workspaceId
  //   - COUNT(r) for all relationship types
  //   - COUNT(r WHERE r.inferred = true)
  //   - DISTINCT connectorId values
  //   - Optional: breakdowns by label and relationship type when includeByType=true
  const now = new Date().toISOString();

  logger.info(
    { includeByType: input.includeByType, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "graph.stats: fetched (stub)",
  );

  return {
    nodeCount: 0,
    edgeCount: 0,
    inferredEdgeCount: 0,
    sourceCount: 0,
    nodesByLabel: input.includeByType ? {} : undefined,
    edgesByType: input.includeByType ? {} : undefined,
    lastModifiedAt: now,
  };
};

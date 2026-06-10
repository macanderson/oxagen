import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeList } from "@oxagen/oxagen/contracts/graph.node.list";
import { logger } from "./logger";

export const graphNodeListHandler: CapabilityHandler<typeof graphNodeList> = async (input, ctx) => {
  // TODO: Query Neo4j for KnowledgeNode nodes scoped to workspaceId, applying
  // label/sourceId/text-search filters with pagination
  logger.info(
    {
      labels: input.labels,
      sourceId: input.sourceId,
      query: input.query,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "graph.node.list: fetched (stub)",
  );

  return {
    nodes: [],
    total: 0,
    hasMore: false,
    limit: input.limit,
    offset: input.offset,
  };
};

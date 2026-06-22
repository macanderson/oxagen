import type { CapabilityHandler } from "@oxagen/oxagen";
import { webSearch as webSearchContract } from "@oxagen/oxagen/contracts/web.search";
import { webSearch } from "@oxagen/web";
import { eventClient } from "./event-client";
import { logger } from "./logger";

export const webSearchHandler: CapabilityHandler<typeof webSearchContract> = async (
  input,
  ctx,
) => {
  logger.info(
    { orgId: ctx.orgId, query: input.query, searchDepth: input.searchDepth },
    "web.search: starting",
  );

  const result = await webSearch({
    query: input.query,
    maxResults: input.maxResults ?? 5,
    searchDepth: input.searchDepth ?? "basic",
    includeDomains: input.includeDomains,
    excludeDomains: input.excludeDomains,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      searchId: result.searchId,
      totalResults: result.totalResults,
    },
    "web.search: complete",
  );

  // Feed the entities this search uncovered into the workspace knowledge graph.
  // EVERY web search routes through this one handler — the in-chat agent, the
  // research swarm's fanned-out children, and the API/MCP/CLI surfaces — so
  // emitting here ingests them all uniformly. web.search.ingest-graph consumes
  // the event and runs graph.ingest (LLM extraction → idempotent node/edge
  // upserts). Best-effort: the search result is the deliverable, ingestion is an
  // async side-effect, so a failure to enqueue must never fail the search.
  if (result.results.length > 0) {
    try {
      await eventClient.send({
        name: "web/search.completed",
        data: {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId ?? null,
          query: input.query,
          results: result.results.map((r) => ({
            title: r.title,
            url: r.url,
            content: r.content,
          })),
        },
      });
    } catch (err) {
      logger.warn(
        { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        "web.search: failed to enqueue knowledge-graph ingestion",
      );
    }
  }

  return result;
};

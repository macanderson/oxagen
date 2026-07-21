import type { CapabilityHandler } from "@oxagen/oxagen";
import { webSearch as webSearchContract } from "@oxagen/oxagen/contracts/web.search";
import { webSearch } from "@oxagen/web";
import { logger } from "./logger";

export const webSearchHandler: CapabilityHandler<
  typeof webSearchContract
> = async (input, ctx) => {
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

  return result;
};

import type { CapabilityHandler } from "@oxagen/oxagen";
import { webFetch as webFetchContract } from "@oxagen/oxagen/contracts/web.fetch";
import { webFetch } from "@oxagen/web";
import { logger } from "./logger";

export const webFetchHandler: CapabilityHandler<
  typeof webFetchContract
> = async (input, ctx) => {
  logger.info(
    {
      orgId: ctx.orgId,
      url: input.url,
      extractMarkdown: input.extractMarkdown,
    },
    "web.fetch: starting",
  );

  const result = await webFetch({
    url: input.url,
    extractMarkdown: input.extractMarkdown ?? true,
    timeout: input.timeout ?? 10000,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      url: result.url,
      statusCode: result.statusCode,
      wordCount: result.wordCount,
    },
    "web.fetch: complete",
  );

  return result;
};

import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { webSearch } from "@oxagen/oxagen/contracts/web.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...webSearch.input.shape,
  query: webSearch.input.shape.query.describe(
    "The search query string (max 500 characters).",
  ),
  maxResults: webSearch.input.shape.maxResults.describe(
    "Maximum number of results to return (1–10, default 5).",
  ),
  searchDepth: webSearch.input.shape.searchDepth.describe(
    'Search depth: "basic" is faster, "advanced" is more thorough (default "basic").',
  ),
  includeDomains: webSearch.input.shape.includeDomains.describe(
    "Optional list of domains to restrict search results to.",
  ),
  excludeDomains: webSearch.input.shape.excludeDomains.describe(
    "Optional list of domains to exclude from search results.",
  ),
};

export const metadata: ToolMetadata = {
  name: webSearch.name,
  description: webSearch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function webSearchTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(webSearch.name, args, ctx, { surface: "mcp" });
  return webSearch.output.parse(output);
}

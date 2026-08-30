import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { referenceSearch } from "@oxagen/oxagen/contracts/reference.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...referenceSearch.input.shape,
  query: referenceSearch.input.shape.query.describe(
    "Free-text search string matched across every referenceable object kind",
  ),
  types: referenceSearch.input.shape.types.describe(
    'Optional list of reference kinds to restrict results to (e.g. ["repository", "agent", "node"])',
  ),
  slug: referenceSearch.input.shape.slug.describe(
    "Exact public-id resolve mode — returns the single matching reference and ignores `query`",
  ),
  limit: referenceSearch.input.shape.limit.describe(
    "Maximum number of results to return (1–25, default 10)",
  ),
};

export const metadata: ToolMetadata = {
  name: referenceSearch.name,
  description: referenceSearch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function referenceSearchTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(referenceSearch.name, args, ctx, {
    surface: "mcp",
  });
  return referenceSearch.output.parse(output);
}

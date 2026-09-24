import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMcpRegistrySearch } from "@oxagen/oxagen/contracts/agent.mcp.registry.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  query: agentMcpRegistrySearch.input.shape.query.describe(
    "Free text matched against a server's name, title and description",
  ),
  cursor: agentMcpRegistrySearch.input.shape.cursor.describe(
    "The nextCursor of the previous page",
  ),
  limit: agentMcpRegistrySearch.input.shape.limit.describe(
    "Results per page, 1 to 30",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMcpRegistrySearch.name,
  description: agentMcpRegistrySearch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export default async function agentMcpRegistrySearchTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMcpRegistrySearch.name, args, ctx, {
    surface: "mcp",
  });
  return agentMcpRegistrySearch.output.parse(output);
}

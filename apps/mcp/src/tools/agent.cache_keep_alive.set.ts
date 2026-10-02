import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentCacheKeepAliveSet } from "@oxagen/oxagen/contracts/agent.cache_keep_alive.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  agent: agentCacheKeepAliveSet.input.shape.agent.describe(
    "The agent's slug in the active workspace",
  ),
  cacheKeepAlive: agentCacheKeepAliveSet.input.shape.cacheKeepAlive.describe(
    "true turns the cache keep-alive on for this agent; false turns it off",
  ),
};

export const metadata: ToolMetadata = {
  name: agentCacheKeepAliveSet.name,
  description: agentCacheKeepAliveSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentCacheKeepAliveSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentCacheKeepAliveSet.name, args, ctx, {
    surface: "mcp",
  });
  return agentCacheKeepAliveSet.output.parse(output);
}

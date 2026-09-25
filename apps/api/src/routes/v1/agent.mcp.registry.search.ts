import { Hono } from "hono";
import { agentMcpRegistrySearch } from "@oxagen/oxagen/contracts/agent.mcp.registry.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpRegistrySearchRoute = new Hono<AppEnv>();

// GET ?query=&cursor=&limit= — the query string is the input.
agentMcpRegistrySearchRoute.get("/", async (c) => {
  const limit = c.req.query("limit");
  const input = agentMcpRegistrySearch.input.parse({
    query: c.req.query("query") ?? "",
    cursor: c.req.query("cursor"),
    ...(limit === undefined ? {} : { limit: Number(limit) }),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpRegistrySearch.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

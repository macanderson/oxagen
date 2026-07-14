import { Hono } from "hono";
import { agentMcpResolve } from "@oxagen/oxagen/contracts/agent.mcp.resolve";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpResolveRoute = new Hono<AppEnv>();

agentMcpResolveRoute.get("/", async (c) => {
  const input = agentMcpResolve.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpResolve.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

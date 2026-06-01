import { Hono } from "hono";
import { agentMcpList } from "@oxagen/oxagen/contracts/agent.mcp.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentMcpListRoute = new Hono<AppEnv>();

agentMcpListRoute.get("/", async (c) => {
  const input = agentMcpList.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpList.name, input, ctx, { surface: "api" });
  return c.json(out);
});

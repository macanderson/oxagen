import { Hono } from "hono";
import { agentMcpList } from "@oxagen/oxagen/capabilities/agent.mcp.list";
import { agentMcpListHandler } from "@oxagen/oxagen/capabilities/agent.mcp.list.handler";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentMcpListRoute = new Hono<AppEnv>();

agentMcpListRoute.get("/", async (c) => {
  const input = agentMcpList.input.parse({});
  const ctx = capabilityContext(c);
  const out = await agentMcpListHandler(input, ctx);
  return c.json(out);
});

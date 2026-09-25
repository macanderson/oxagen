import { Hono } from "hono";
import { agentMcpAuthorizeStart } from "@oxagen/oxagen/contracts/agent.mcp.authorize.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpAuthorizeStartRoute = new Hono<AppEnv>();

agentMcpAuthorizeStartRoute.post("/", async (c) => {
  const body = agentMcpAuthorizeStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpAuthorizeStart.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

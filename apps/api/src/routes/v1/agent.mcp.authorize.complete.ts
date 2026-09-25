import { Hono } from "hono";
import { agentMcpAuthorizeComplete } from "@oxagen/oxagen/contracts/agent.mcp.authorize.complete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpAuthorizeCompleteRoute = new Hono<AppEnv>();

agentMcpAuthorizeCompleteRoute.post("/", async (c) => {
  const body = agentMcpAuthorizeComplete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpAuthorizeComplete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

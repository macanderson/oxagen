import { Hono } from "hono";
import { agentMcpSetEnabled } from "@oxagen/oxagen/contracts/agent.mcp.set_enabled";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpSetEnabledRoute = new Hono<AppEnv>();

agentMcpSetEnabledRoute.post("/", async (c) => {
  const body = agentMcpSetEnabled.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpSetEnabled.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

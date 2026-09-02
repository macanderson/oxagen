import { Hono } from "hono";
import { agentMcpConsentResolve } from "@oxagen/oxagen/contracts/agent.mcp_consent.resolve";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpConsentResolveRoute = new Hono<AppEnv>();

agentMcpConsentResolveRoute.post("/", async (c) => {
  const body = agentMcpConsentResolve.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpConsentResolve.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

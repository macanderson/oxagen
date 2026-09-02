import { Hono } from "hono";
import { agentMcpConsentList } from "@oxagen/oxagen/contracts/agent.mcp_consent.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpConsentListRoute = new Hono<AppEnv>();

agentMcpConsentListRoute.post("/", async (c) => {
  const body = agentMcpConsentList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpConsentList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

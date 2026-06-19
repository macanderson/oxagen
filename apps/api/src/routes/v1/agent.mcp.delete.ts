import { Hono } from "hono";
import { agentMcpDelete } from "@oxagen/oxagen/contracts/agent.mcp.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpDeleteRoute = new Hono<AppEnv>();

agentMcpDeleteRoute.post("/", async (c) => {
  const body = agentMcpDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpDelete.name, body, ctx, { surface: "api" });
  return c.json(out);
});

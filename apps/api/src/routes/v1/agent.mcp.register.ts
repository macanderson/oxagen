import { Hono } from "hono";
import { agentMcpRegister } from "@oxagen/oxagen/capabilities/agent.mcp.register";
import { agentMcpRegisterHandler } from "@oxagen/agent/handlers/agent.mcp.register";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentMcpRegisterRoute = new Hono<AppEnv>();

agentMcpRegisterRoute.post("/", async (c) => {
  const body = agentMcpRegister.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await agentMcpRegisterHandler(body, ctx);
  return c.json(out, 201);
});

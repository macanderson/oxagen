import { Hono } from "hono";
import { agentMcpRegister } from "@oxagen/oxagen/contracts/agent.mcp.register";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMcpRegisterRoute = new Hono<AppEnv>();

agentMcpRegisterRoute.post("/", async (c) => {
  const body = agentMcpRegister.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMcpRegister.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});

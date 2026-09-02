import { Hono } from "hono";
import { agentMemoryRemember } from "@oxagen/oxagen/contracts/agent.memory.remember";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryRememberRoute = new Hono<AppEnv>();

agentMemoryRememberRoute.post("/", async (c) => {
  const body = agentMemoryRemember.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryRemember.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});

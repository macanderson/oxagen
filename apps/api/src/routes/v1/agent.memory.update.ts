import { Hono } from "hono";
import { agentMemoryUpdate } from "@oxagen/oxagen/contracts/agent.memory.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryUpdateRoute = new Hono<AppEnv>();

agentMemoryUpdateRoute.post("/", async (c) => {
  const body = agentMemoryUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryUpdate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

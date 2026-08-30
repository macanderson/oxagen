import { Hono } from "hono";
import { agentMemoryDelete } from "@oxagen/oxagen/contracts/agent.memory.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryDeleteRoute = new Hono<AppEnv>();

agentMemoryDeleteRoute.post("/", async (c) => {
  const body = agentMemoryDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

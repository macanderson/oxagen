import { Hono } from "hono";
import { agentMemoryPromote } from "@oxagen/oxagen/contracts/agent.memory.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryPromoteRoute = new Hono<AppEnv>();

agentMemoryPromoteRoute.post("/", async (c) => {
  const body = agentMemoryPromote.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryPromote.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

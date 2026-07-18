import { Hono } from "hono";
import { agentMemoryDemote } from "@oxagen/oxagen/contracts/agent.memory.demote";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryDemoteRoute = new Hono<AppEnv>();

agentMemoryDemoteRoute.post("/", async (c) => {
  const body = agentMemoryDemote.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryDemote.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

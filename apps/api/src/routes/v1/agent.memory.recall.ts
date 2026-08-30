import { Hono } from "hono";
import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentMemoryRecallRoute = new Hono<AppEnv>();

agentMemoryRecallRoute.post("/", async (c) => {
  const body = agentMemoryRecall.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentMemoryRecall.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

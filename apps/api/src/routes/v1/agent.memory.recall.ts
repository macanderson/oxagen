import { Hono } from "hono";
import { agentMemoryRecall } from "@oxagen/oxagen/capabilities/agent.memory.recall";
import { agentMemoryRecallHandler } from "@oxagen/agent/handlers/agent.memory.recall";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentMemoryRecallRoute = new Hono<AppEnv>();

agentMemoryRecallRoute.post("/", async (c) => {
  const body = agentMemoryRecall.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await agentMemoryRecallHandler(body, ctx);
  return c.json(out);
});

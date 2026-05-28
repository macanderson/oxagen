import { Hono } from "hono";
import { agentMemoryWrite } from "@oxagen/oxagen/capabilities/agent.memory.write";
import { agentMemoryWriteHandler } from "@oxagen/oxagen/capabilities/agent.memory.write.handler";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentMemoryWriteRoute = new Hono<AppEnv>();

agentMemoryWriteRoute.post("/", async (c) => {
  const body = agentMemoryWrite.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await agentMemoryWriteHandler(body, ctx);
  return c.json(out, 201);
});

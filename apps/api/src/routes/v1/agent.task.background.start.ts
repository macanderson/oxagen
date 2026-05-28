import { Hono } from "hono";
import { agentTaskBackgroundStart } from "@oxagen/oxagen/capabilities/agent.task.background.start";
import { agentTaskBackgroundStartHandler } from "@oxagen/agent/handlers/agent.task.background.start";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentTaskBackgroundStartRoute = new Hono<AppEnv>();

agentTaskBackgroundStartRoute.post("/", async (c) => {
  const body = agentTaskBackgroundStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  // Zod infers `payload` as optional from `z.unknown()`; the handler's
  // hand-written interface marks it required. Bridge the inference gap.
  const out = await agentTaskBackgroundStartHandler(body as unknown as Parameters<typeof agentTaskBackgroundStartHandler>[0], ctx);
  return c.json(out, 202);
});

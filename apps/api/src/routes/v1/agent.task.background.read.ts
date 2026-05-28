import { Hono } from "hono";
import { agentTaskBackgroundRead } from "@oxagen/oxagen/capabilities/agent.task.background.read";
import { agentTaskBackgroundReadHandler } from "@oxagen/oxagen/capabilities/agent.task.background.read.handler";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentTaskBackgroundReadRoute = new Hono<AppEnv>();

agentTaskBackgroundReadRoute.get("/:taskId", async (c) => {
  const input = agentTaskBackgroundRead.input.parse({
    taskId: c.req.param("taskId"),
  });
  const ctx = capabilityContext(c);
  const out = await agentTaskBackgroundReadHandler(input, ctx);
  return c.json(out);
});

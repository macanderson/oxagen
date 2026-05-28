import { Hono } from "hono";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/capabilities/agent.task.background.cancel";
import { agentTaskBackgroundCancelHandler } from "@oxagen/oxagen/capabilities/agent.task.background.cancel.handler";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentTaskBackgroundCancelRoute = new Hono<AppEnv>();

agentTaskBackgroundCancelRoute.post("/", async (c) => {
  const body = agentTaskBackgroundCancel.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await agentTaskBackgroundCancelHandler(body, ctx);
  return c.json(out);
});

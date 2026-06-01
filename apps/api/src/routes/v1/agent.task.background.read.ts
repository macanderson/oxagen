import { Hono } from "hono";
import { agentTaskBackgroundRead } from "@oxagen/oxagen/contracts/agent.task.background.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentTaskBackgroundReadRoute = new Hono<AppEnv>();

agentTaskBackgroundReadRoute.get("/:taskId", async (c) => {
  const input = agentTaskBackgroundRead.input.parse({
    taskId: c.req.param("taskId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentTaskBackgroundRead.name, input, ctx, { surface: "api" });
  return c.json(out);
});

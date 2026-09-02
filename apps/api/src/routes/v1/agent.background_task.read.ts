import { Hono } from "hono";
import { agentTaskBackgroundRead } from "@oxagen/oxagen/contracts/agent.background_task.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTaskBackgroundReadRoute = new Hono<AppEnv>();

agentTaskBackgroundReadRoute.get("/:taskId", async (c) => {
  const input = agentTaskBackgroundRead.input.parse({
    taskId: c.req.param("taskId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentTaskBackgroundRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

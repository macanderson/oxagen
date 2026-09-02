import { Hono } from "hono";
import { agentTaskBackgroundStart } from "@oxagen/oxagen/contracts/agent.background_task.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTaskBackgroundStartRoute = new Hono<AppEnv>();

agentTaskBackgroundStartRoute.post("/", async (c) => {
  const body = agentTaskBackgroundStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentTaskBackgroundStart.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 202);
});

import { Hono } from "hono";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/contracts/agent.background_task.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTaskBackgroundCancelRoute = new Hono<AppEnv>();

agentTaskBackgroundCancelRoute.post("/", async (c) => {
  const body = agentTaskBackgroundCancel.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentTaskBackgroundCancel.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

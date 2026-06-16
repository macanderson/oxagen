import { Hono } from "hono";
import { agentTriggerUpdate } from "@oxagen/oxagen/contracts/agent.trigger.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTriggerUpdateRoute = new Hono<AppEnv>();

agentTriggerUpdateRoute.post("/", async (c) => {
  const input = agentTriggerUpdate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentTriggerUpdate.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

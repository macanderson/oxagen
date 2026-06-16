import { Hono } from "hono";
import { agentTriggerDelete } from "@oxagen/oxagen/contracts/agent.trigger.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTriggerDeleteRoute = new Hono<AppEnv>();

agentTriggerDeleteRoute.post("/", async (c) => {
  const input = agentTriggerDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentTriggerDelete.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

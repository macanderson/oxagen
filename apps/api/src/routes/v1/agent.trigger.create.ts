import { Hono } from "hono";
import { agentTriggerCreate } from "@oxagen/oxagen/contracts/agent.trigger.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTriggerCreateRoute = new Hono<AppEnv>();

agentTriggerCreateRoute.post("/", async (c) => {
  const input = agentTriggerCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentTriggerCreate.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});

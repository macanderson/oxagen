import { Hono } from "hono";
import { agentTriggerList } from "@oxagen/oxagen/contracts/agent.trigger.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentTriggerListRoute = new Hono<AppEnv>();

agentTriggerListRoute.get("/:agentId", async (c) => {
  const input = agentTriggerList.input.parse({
    agentId: c.req.param("agentId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentTriggerList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

import { Hono } from "hono";
import { agentSubagentCancel } from "@oxagen/oxagen/contracts/agent.subagent.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentCancelRoute = new Hono<AppEnv>();

agentSubagentCancelRoute.post("/:fanoutId", async (c) => {
  const input = agentSubagentCancel.input.parse({
    fanoutId: c.req.param("fanoutId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentSubagentCancel.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

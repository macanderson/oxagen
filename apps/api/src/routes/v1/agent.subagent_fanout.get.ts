import { Hono } from "hono";
import { agentSubagentFanoutGet } from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentFanoutGetRoute = new Hono<AppEnv>();

agentSubagentFanoutGetRoute.get("/:fanoutId", async (c) => {
  const input = agentSubagentFanoutGet.input.parse({
    fanoutId: c.req.param("fanoutId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentSubagentFanoutGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

import { Hono } from "hono";
import { agentSubagentAggregate } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentAggregateRoute = new Hono<AppEnv>();

agentSubagentAggregateRoute.post("/", async (c) => {
  const body = agentSubagentAggregate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSubagentAggregate.name, body, ctx, { surface: "api" });
  return c.json(out);
});

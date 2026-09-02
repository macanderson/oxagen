import { Hono } from "hono";
import { agentSubagentDispatch } from "@oxagen/oxagen/contracts/agent.subagent.dispatch";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentDispatchRoute = new Hono<AppEnv>();

agentSubagentDispatchRoute.post("/", async (c) => {
  const body = agentSubagentDispatch.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSubagentDispatch.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 202);
});

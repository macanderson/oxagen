import { Hono } from "hono";
import { agentPlanCreate } from "@oxagen/oxagen/contracts/agent.plan.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentPlanCreateRoute = new Hono<AppEnv>();

agentPlanCreateRoute.post("/", async (c) => {
  const body = agentPlanCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentPlanCreate.name, body, ctx, { surface: "api" });
  return c.json(out);
});

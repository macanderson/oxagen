import { Hono } from "hono";
import { agentPlanApprove } from "@oxagen/oxagen/contracts/agent.plan.approve";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentPlanApproveRoute = new Hono<AppEnv>();

agentPlanApproveRoute.post("/", async (c) => {
  const body = agentPlanApprove.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentPlanApprove.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

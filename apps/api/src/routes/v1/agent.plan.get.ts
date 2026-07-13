import { Hono } from "hono";
import { agentPlanGet } from "@oxagen/oxagen/contracts/agent.plan.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentPlanGetRoute = new Hono<AppEnv>();

agentPlanGetRoute.post("/", async (c) => {
  const body = agentPlanGet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentPlanGet.name, body, ctx, { surface: "api" });
  return c.json(out);
});

import { Hono } from "hono";
import { agentFeatureVerify } from "@oxagen/oxagen/contracts/agent.feature.verify";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentFeatureVerifyRoute = new Hono<AppEnv>();

agentFeatureVerifyRoute.post("/", async (c) => {
  const body = agentFeatureVerify.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentFeatureVerify.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

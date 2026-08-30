import { Hono } from "hono";
import { agentEnvironmentBind } from "@oxagen/oxagen/contracts/agent.environment.bind";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentEnvironmentBindRoute = new Hono<AppEnv>();

agentEnvironmentBindRoute.post("/", async (c) => {
  const body = agentEnvironmentBind.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentEnvironmentBind.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

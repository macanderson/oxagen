import { Hono } from "hono";
import { agentEnvironmentUnbind } from "@oxagen/oxagen/contracts/agent.environment.unbind";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentEnvironmentUnbindRoute = new Hono<AppEnv>();

agentEnvironmentUnbindRoute.post("/", async (c) => {
  const body = agentEnvironmentUnbind.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentEnvironmentUnbind.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

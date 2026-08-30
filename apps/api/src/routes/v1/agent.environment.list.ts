import { Hono } from "hono";
import { agentEnvironmentList } from "@oxagen/oxagen/contracts/agent.environment.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentEnvironmentListRoute = new Hono<AppEnv>();

agentEnvironmentListRoute.post("/", async (c) => {
  const body = agentEnvironmentList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentEnvironmentList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

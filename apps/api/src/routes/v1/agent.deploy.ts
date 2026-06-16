import { Hono } from "hono";
import { agentDeploy } from "@oxagen/oxagen/contracts/agent.deploy";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentDeployRoute = new Hono<AppEnv>();

agentDeployRoute.post("/", async (c) => {
  const input = agentDeploy.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentDeploy.name, input, ctx, { surface: "api" });
  return c.json(out);
});

import { Hono } from "hono";
import { agentSandboxStop } from "@oxagen/oxagen/contracts/agent.sandbox.stop";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxStopRoute = new Hono<AppEnv>();

agentSandboxStopRoute.post("/", async (c) => {
  const body = agentSandboxStop.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxStop.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

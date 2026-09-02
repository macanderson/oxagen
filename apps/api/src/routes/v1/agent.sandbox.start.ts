import { Hono } from "hono";
import { agentSandboxStart } from "@oxagen/oxagen/contracts/agent.sandbox.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxStartRoute = new Hono<AppEnv>();

agentSandboxStartRoute.post("/", async (c) => {
  const body = agentSandboxStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxStart.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

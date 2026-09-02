import { Hono } from "hono";
import { agentSandboxExec } from "@oxagen/oxagen/contracts/agent.sandbox.exec";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxExecRoute = new Hono<AppEnv>();

agentSandboxExecRoute.post("/", async (c) => {
  const body = agentSandboxExec.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxExec.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

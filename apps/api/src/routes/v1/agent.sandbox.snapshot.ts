import { Hono } from "hono";
import { agentSandboxSnapshot } from "@oxagen/oxagen/contracts/agent.sandbox.snapshot";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxSnapshotRoute = new Hono<AppEnv>();

agentSandboxSnapshotRoute.post("/", async (c) => {
  const body = agentSandboxSnapshot.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxSnapshot.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

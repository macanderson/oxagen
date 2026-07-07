import { Hono } from "hono";
import { agentSandboxFileRead } from "@oxagen/oxagen/contracts/agent.sandbox_file.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxFileReadRoute = new Hono<AppEnv>();

// POST /v1/:org/:workspace/agent/sandbox/file
// Body: { sessionId, path, maxBytes? }
agentSandboxFileReadRoute.post("/", async (c) => {
  const body = agentSandboxFileRead.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxFileRead.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

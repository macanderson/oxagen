import { Hono } from "hono";
import { agentSandboxRename } from "@oxagen/oxagen/contracts/agent.sandbox.rename";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxRenameRoute = new Hono<AppEnv>();

// POST /v1/:org/:workspace/agent/sandbox/rename
// Body: { sessionId, label }
agentSandboxRenameRoute.post("/", async (c) => {
  const body = agentSandboxRename.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxRename.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

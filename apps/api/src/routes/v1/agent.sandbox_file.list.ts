import { Hono } from "hono";
import { agentSandboxFilesList } from "@oxagen/oxagen/contracts/agent.sandbox_file.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxFilesListRoute = new Hono<AppEnv>();

// POST /v1/:org/:workspace/agent/sandbox/files
// Body: { sessionId, path?, depth? }
agentSandboxFilesListRoute.post("/", async (c) => {
  const body = agentSandboxFilesList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxFilesList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

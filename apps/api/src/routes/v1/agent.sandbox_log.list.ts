import { Hono } from "hono";
import { agentSandboxLogsList } from "@oxagen/oxagen/contracts/agent.sandbox_log.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSandboxLogsListRoute = new Hono<AppEnv>();

// POST /v1/:org/:workspace/agent/sandbox/logs
// Body: { sessionId, level?, limit?, sinceMs? }
agentSandboxLogsListRoute.post("/", async (c) => {
  const body = agentSandboxLogsList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentSandboxLogsList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

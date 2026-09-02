import { Hono } from "hono";
import { agentSubagentLogs } from "@oxagen/oxagen/contracts/agent.subagent.logs";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentLogsRoute = new Hono<AppEnv>();

agentSubagentLogsRoute.post("/", async (c) => {
  const body = agentSubagentLogs.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(agentSubagentLogs.name, body, ctx, {
    surface: "api",
  });
  return c.json(result);
});

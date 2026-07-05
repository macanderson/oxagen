import { Hono } from "hono";
import { agentExecutionLineage } from "@oxagen/oxagen/contracts/agent.execution.lineage";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentExecutionLineageRoute = new Hono<AppEnv>();

agentExecutionLineageRoute.get("/:executionId", async (c) => {
  const input = agentExecutionLineage.input.parse({ executionId: c.req.param("executionId") });
  const ctx = capabilityContext(c);
  const out = await invoke(agentExecutionLineage.name, input, ctx, { surface: "api" });
  return c.json(out);
});

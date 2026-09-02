import { Hono } from "hono";
import { agentExecutionRecord } from "@oxagen/oxagen/contracts/agent.execution.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentExecutionRecordRoute = new Hono<AppEnv>();

agentExecutionRecordRoute.post("/", async (c) => {
  const body = agentExecutionRecord.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentExecutionRecord.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

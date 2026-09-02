import { Hono } from "hono";
import { agentExecutionList } from "@oxagen/oxagen/contracts/agent.execution.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentExecutionListRoute = new Hono<AppEnv>();

agentExecutionListRoute.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const input = agentExecutionList.input.parse({
    limit: limitParam ? Number(limitParam) : undefined,
    before: c.req.query("before") ?? undefined,
    status: c.req.query("status") ?? undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentExecutionList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

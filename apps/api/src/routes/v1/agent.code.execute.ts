import { Hono } from "hono";
import { agentCodeExecute } from "@oxagen/oxagen/contracts/agent.code.execute";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentCodeExecuteRoute = new Hono<AppEnv>();

agentCodeExecuteRoute.post("/", async (c) => {
  const body = agentCodeExecute.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentCodeExecute.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

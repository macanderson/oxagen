import { Hono } from "hono";
import { agentToolList } from "@oxagen/oxagen/capabilities/agent.tool.list";
import { agentToolListHandler } from "@oxagen/agent/handlers/agent.tool.list";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentToolListRoute = new Hono<AppEnv>();

agentToolListRoute.post("/", async (c) => {
  const body = agentToolList.input.parse(await c.req.json().catch(() => ({})));
  const ctx = capabilityContext(c);
  const out = await agentToolListHandler(body, ctx);
  return c.json(out);
});

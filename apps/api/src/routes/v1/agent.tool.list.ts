import { Hono } from "hono";
import { agentToolList } from "@oxagen/oxagen/contracts/agent.tool.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentToolListRoute = new Hono<AppEnv>();

agentToolListRoute.post("/", async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  const body = agentToolList.input.parse(raw ?? {});
  const ctx = capabilityContext(c);
  const out = await invoke(agentToolList.name, body, ctx, { surface: "api" });
  return c.json(out);
});

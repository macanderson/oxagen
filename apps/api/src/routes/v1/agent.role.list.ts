import { Hono } from "hono";
import { agentRoleList } from "@oxagen/oxagen/contracts/agent.role.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentRoleListRoute = new Hono<AppEnv>();

agentRoleListRoute.get("/", async (c) => {
  const input = agentRoleList.input.parse({
    agentId: c.req.query("agentId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentRoleList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

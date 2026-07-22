import { Hono } from "hono";
import { agentRoleGet } from "@oxagen/oxagen/contracts/agent.role.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentRoleGetRoute = new Hono<AppEnv>();

agentRoleGetRoute.get("/", async (c) => {
  const input = agentRoleGet.input.parse({
    agentId: c.req.query("agentId"),
    roleId: c.req.query("roleId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(agentRoleGet.name, input, ctx, { surface: "api" });
  return c.json(out, 200);
});

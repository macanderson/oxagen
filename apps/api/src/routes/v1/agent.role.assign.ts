import { Hono } from "hono";
import { agentRoleAssign } from "@oxagen/oxagen/contracts/agent.role.assign";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentRoleAssignRoute = new Hono<AppEnv>();

agentRoleAssignRoute.post("/", async (c) => {
  const input = agentRoleAssign.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentRoleAssign.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

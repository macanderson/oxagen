import { Hono } from "hono";
import { agentRoleRevoke } from "@oxagen/oxagen/contracts/agent.role.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentRoleRevokeRoute = new Hono<AppEnv>();

agentRoleRevokeRoute.post("/", async (c) => {
  const input = agentRoleRevoke.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentRoleRevoke.name, input, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

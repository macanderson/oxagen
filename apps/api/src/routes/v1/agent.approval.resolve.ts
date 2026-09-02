import { Hono } from "hono";
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentApprovalResolveRoute = new Hono<AppEnv>();

agentApprovalResolveRoute.post("/", async (c) => {
  const body = agentApprovalResolve.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentApprovalResolve.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

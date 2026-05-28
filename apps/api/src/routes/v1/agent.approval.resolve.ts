import { Hono } from "hono";
import { agentApprovalResolve } from "@oxagen/oxagen/capabilities/agent.approval.resolve";
import { agentApprovalResolveHandler } from "@oxagen/agent/handlers/agent.approval.resolve";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentApprovalResolveRoute = new Hono<AppEnv>();

agentApprovalResolveRoute.post("/", async (c) => {
  const body = agentApprovalResolve.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await agentApprovalResolveHandler(body, ctx);
  return c.json(out);
});

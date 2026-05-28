import { Hono } from "hono";
import { agentPlanApprove } from "@oxagen/oxagen/contracts/agent.plan.approve";
import { agentPlanApproveHandler } from "@oxagen/agent/handlers/agent.plan.approve";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const agentPlanApproveRoute = new Hono<AppEnv>();

agentPlanApproveRoute.post("/", async (c) => {
  const body = agentPlanApprove.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  // Zod infers `inputPreview` as optional from `z.unknown().nullable()` but
  // the handler's hand-written interface marks it required. The values are
  // structurally compatible; cast through `unknown` to bridge the inference gap.
  const out = await agentPlanApproveHandler(body as unknown as Parameters<typeof agentPlanApproveHandler>[0], ctx);
  return c.json(out);
});

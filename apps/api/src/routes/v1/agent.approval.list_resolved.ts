import { Hono } from "hono";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentApprovalListResolvedRoute = new Hono<AppEnv>();

agentApprovalListResolvedRoute.post("/", async (c) => {
  const body = agentApprovalListResolved.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentApprovalListResolved.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

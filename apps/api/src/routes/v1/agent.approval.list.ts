import { Hono } from "hono";
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentApprovalListRoute = new Hono<AppEnv>();

agentApprovalListRoute.post("/", async (c) => {
  const body = agentApprovalList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentApprovalList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

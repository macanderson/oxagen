import { Hono } from "hono";
import { billingUsageBreakdown } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingUsageBreakdownRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/billing/usage/breakdown?start&end&workspace_id
billingUsageBreakdownRoute.get("/", async (c) => {
  const input = billingUsageBreakdown.input.parse({
    start: c.req.query("start"),
    end: c.req.query("end"),
    workspaceId: c.req.query("workspace_id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(billingUsageBreakdown.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

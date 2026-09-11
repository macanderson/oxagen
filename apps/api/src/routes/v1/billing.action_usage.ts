import { Hono } from "hono";
import { billingActionUsage } from "@oxagen/oxagen/contracts/billing.action_usage";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingActionUsageRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/billing/actions/usage?include_breakdown
billingActionUsageRoute.get("/", async (c) => {
  const includeBreakdownRaw = c.req.query("include_breakdown");
  const input = billingActionUsage.input.parse({
    includeBreakdown:
      includeBreakdownRaw === undefined
        ? undefined
        : includeBreakdownRaw === "true",
  });
  const ctx = capabilityContext(c);
  const out = await invoke(billingActionUsage.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

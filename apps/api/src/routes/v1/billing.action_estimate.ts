import { Hono } from "hono";
import { billingActionEstimate } from "@oxagen/oxagen/contracts/billing.action_estimate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingActionEstimateRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/billing/actions/estimate?runs_per_year&run_class&actions_per_run&tier
billingActionEstimateRoute.get("/", async (c) => {
  const runsPerYearRaw = c.req.query("runs_per_year");
  const actionsPerRunRaw = c.req.query("actions_per_run");
  const input = billingActionEstimate.input.parse({
    runsPerYear:
      runsPerYearRaw === undefined ? undefined : Number(runsPerYearRaw),
    runClass: c.req.query("run_class"),
    actionsPerRun:
      actionsPerRunRaw === undefined ? undefined : Number(actionsPerRunRaw),
    tier: c.req.query("tier"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(billingActionEstimate.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

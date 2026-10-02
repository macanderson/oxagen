import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendWorkOrderMetrics } from "@oxagen/oxagen/contracts/spend.work_order_metrics";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The operator and work order metrics and unassigned spend for each week of a day range. Managers only. Mounted on the org-scoped router behind session auth. */
export const spendWorkOrderMetricsRoute = new Hono<AppEnv>();

spendWorkOrderMetricsRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendWorkOrderMetrics.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendWorkOrderMetrics.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

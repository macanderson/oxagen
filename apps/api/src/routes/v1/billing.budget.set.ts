import { Hono } from "hono";
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingBudgetSetRoute = new Hono<AppEnv>();

billingBudgetSetRoute.put("/", async (c) => {
  const body = billingBudgetSet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(billingBudgetSet.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

import { Hono } from "hono";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingBudgetGetRoute = new Hono<AppEnv>();

billingBudgetGetRoute.get("/", async (c) => {
  const input = billingBudgetGet.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(billingBudgetGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

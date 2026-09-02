import { Hono } from "hono";
import { billingCreditsPurchase } from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingCreditsPurchaseRoute = new Hono<AppEnv>();

billingCreditsPurchaseRoute.post("/", async (c) => {
  const body = billingCreditsPurchase.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(billingCreditsPurchase.name, body, ctx, {
    surface: "api",
  });
  return c.json(result);
});

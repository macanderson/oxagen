import { Hono } from "hono";
import { billingActionRateCard } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingActionRateCardRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/billing/actions/rate-card
billingActionRateCardRoute.get("/", async (c) => {
  const input = billingActionRateCard.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(billingActionRateCard.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

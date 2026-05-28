import { Hono } from "hono";
import { billingSubscriptionRead } from "@oxagen/oxagen/capabilities/billing.subscription.read";
import { billingSubscriptionReadHandler } from "@oxagen/handlers/billing.subscription.read";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const billingSubscriptionReadRoute = new Hono<AppEnv>();

billingSubscriptionReadRoute.get("/", async (c) => {
  const input = billingSubscriptionRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await billingSubscriptionReadHandler(input, ctx);
  return c.json(out);
});

import { Hono } from "hono";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription.upgrade.start";
import { billingSubscriptionUpgradeStartHandler } from "@oxagen/handlers/billing.subscription.upgrade.start";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const billingSubscriptionUpgradeStartRoute = new Hono<AppEnv>();

billingSubscriptionUpgradeStartRoute.post("/", async (c) => {
  const body = billingSubscriptionUpgradeStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await billingSubscriptionUpgradeStartHandler(body, ctx);
  return c.json(billingSubscriptionUpgradeStart.output.parse(result));
});

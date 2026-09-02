import { Hono } from "hono";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingSubscriptionUpgradeStartRoute = new Hono<AppEnv>();

billingSubscriptionUpgradeStartRoute.post("/", async (c) => {
  const body = billingSubscriptionUpgradeStart.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(billingSubscriptionUpgradeStart.name, body, ctx, {
    surface: "api",
  });
  return c.json(result);
});

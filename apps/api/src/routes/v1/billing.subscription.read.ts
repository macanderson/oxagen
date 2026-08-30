import { Hono } from "hono";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingSubscriptionReadRoute = new Hono<AppEnv>();

billingSubscriptionReadRoute.get("/", async (c) => {
  const input = billingSubscriptionRead.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(billingSubscriptionRead.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

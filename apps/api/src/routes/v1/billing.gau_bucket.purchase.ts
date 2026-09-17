import { Hono } from "hono";
import { billingGauBucketPurchase } from "@oxagen/oxagen/contracts/billing.gau_bucket.purchase";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingGauBucketPurchaseRoute = new Hono<AppEnv>();

billingGauBucketPurchaseRoute.post("/", async (c) => {
  const body = billingGauBucketPurchase.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(billingGauBucketPurchase.name, body, ctx, {
    surface: "api",
  });
  return c.json(result);
});

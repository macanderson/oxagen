import { Hono } from "hono";
import { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read the organization's governed action unit bucket for the current month. Mounted on the org-scoped router behind session auth. */
export const billingGauBucketGetRoute = new Hono<AppEnv>();

billingGauBucketGetRoute.get("/", async (c) => {
  const input = billingGauBucketGet.input.parse({});
  const ctx = capabilityContext(c);
  const output = await invoke(billingGauBucketGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

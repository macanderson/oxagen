import { Hono } from "hono";
import { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingContractRateGetRoute = new Hono<AppEnv>();

billingContractRateGetRoute.get("/", async (c) => {
  const input = billingContractRateGet.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(billingContractRateGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

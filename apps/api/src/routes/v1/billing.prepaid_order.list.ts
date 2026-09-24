import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { billingPrepaidOrderList } from "@oxagen/oxagen/contracts/billing.prepaid_order.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the organization's prepaid orders, newest first. Mounted on the org-scoped router behind session auth. */
export const billingPrepaidOrderListRoute = new Hono<AppEnv>();

billingPrepaidOrderListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = billingPrepaidOrderList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(billingPrepaidOrderList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

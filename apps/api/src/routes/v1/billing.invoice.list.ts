import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** List the organization's invoices, newest first. Mounted on the org-scoped router behind session auth. */
export const billingInvoiceListRoute = new Hono<AppEnv>();

billingInvoiceListRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = billingInvoiceList.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(billingInvoiceList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

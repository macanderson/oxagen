import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { billingAutoTopupSet } from "@oxagen/oxagen/contracts/billing.auto_topup.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Save the organization's auto top-up setting. Mounted on the org-scoped router behind session auth. */
export const billingAutoTopupSetRoute = new Hono<AppEnv>();

billingAutoTopupSetRoute.put("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = billingAutoTopupSet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(billingAutoTopupSet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

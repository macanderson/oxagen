import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { billingStatementGet } from "@oxagen/oxagen/contracts/billing.statement.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** The organization's billing statement for one period. Mounted on the org-scoped router behind session auth. */
export const billingStatementGetRoute = new Hono<AppEnv>();

billingStatementGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = billingStatementGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(billingStatementGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

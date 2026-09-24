import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { billingStatementExport } from "@oxagen/oxagen/contracts/billing.statement.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * The organization's billing statement as a CSV page or an HTML document,
 * answered as JSON with the content, the filename and the media type. A CSV
 * page with more rows to follow carries `nextCursor`. Mounted on the
 * org-scoped router behind session auth.
 */
export const billingStatementExportRoute = new Hono<AppEnv>();

billingStatementExportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = billingStatementExport.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(billingStatementExport.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendCostCenterStatementExport } from "@oxagen/oxagen/contracts/spend.cost_center_statement.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Export the organization's monthly chargeback statement as CSV, one line per cost center. Mounted on the org-scoped router behind session auth. */
export const spendCostCenterStatementExportRoute = new Hono<AppEnv>();

spendCostCenterStatementExportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendCostCenterStatementExport.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendCostCenterStatementExport.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

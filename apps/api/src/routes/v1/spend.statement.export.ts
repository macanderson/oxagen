import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Export this workspace's monthly spend statement as CSV. Mounted on the org-scoped router behind session auth. */
export const spendStatementExportRoute = new Hono<AppEnv>();

spendStatementExportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = spendStatementExport.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(spendStatementExport.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

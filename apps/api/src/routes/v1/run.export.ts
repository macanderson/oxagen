import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runExport } from "@oxagen/oxagen/contracts/run.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Queue the signed evidence bundle for a sealed run; org Owner or Admin. Mounted on the org-scoped router behind session auth. */
export const runExportRoute = new Hono<AppEnv>();

runExportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runExport.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runExport.name, input, ctx, { surface: "api" });
  return c.json(output);
});

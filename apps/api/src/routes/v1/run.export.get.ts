import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { runExportGet } from "@oxagen/oxagen/contracts/run.export.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read one run export's status and a download URL; org Owner or Admin. Mounted on the org-scoped router behind session auth. */
export const runExportGetRoute = new Hono<AppEnv>();

runExportGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = runExportGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(runExportGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

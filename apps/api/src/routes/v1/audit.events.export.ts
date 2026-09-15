import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Export the org's security audit events as a signed CSV or NDJSON file. Mounted on the org-scoped router. */
export const auditEventsExportRoute = new Hono<AppEnv>();

auditEventsExportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = auditEventsExport.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(auditEventsExport.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});

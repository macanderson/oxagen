import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { telemetryStellaEnroll } from "@oxagen/oxagen/contracts/telemetry.stella.enroll";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Mint a signed Stella enterprise-telemetry enrollment for the calling
 * workspace.
 *
 * Mounted on the org-scoped router, not beside the ingest route: ingest is
 * machine traffic authenticated by the enrolled API key, while this is the
 * operator action that CREATES such a key, so it needs a real signed-in human
 * (`authMiddleware`) whose org role the handler checks. Putting it behind the
 * same API-key gate as ingest would let an already-enrolled machine mint
 * further enrollments for itself.
 *
 * The response carries two secrets, each shown once and never recoverable —
 * the raw API key and the signed managed-settings document. Nothing here logs
 * the body.
 */
export const telemetryStellaEnrollRoute = new Hono<AppEnv>();

telemetryStellaEnrollRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = telemetryStellaEnroll.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(telemetryStellaEnroll.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});

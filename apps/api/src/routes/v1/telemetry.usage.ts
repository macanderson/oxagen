/**
 * POST /v1/telemetry/usage — public, unauthenticated ingest for anonymous CLI
 * usage telemetry (OSS trust surface — see TELEMETRY.md at the repo root for
 * the full disclosure).
 *
 * No session or API key is required or accepted: OSS/BYOK users may have
 * neither, and the payload is anonymous by design (a random per-install id,
 * never a user identity, org, or workspace). The security boundary is:
 *   - strict schema validation — parseUsageEventPayload / UsageEventPayloadSchema
 *     `.strict()` (@oxagen/telemetry/usage-events) rejects any field outside
 *     the documented allowlist and any value outside its shape, so a bad or
 *     compromised client cannot smuggle a prompt, file path, secret, or any
 *     other unexpected content through this route;
 *   - a per-IP rate limit (defense-in-depth abuse protection for a public,
 *     unauthenticated surface — see middleware/rate-limit.ts).
 *
 * `timestamp` is deliberately NOT accepted from the client — it is stamped
 * here, server-side, so a wrong or adversarial local clock can never produce
 * spoofed historical rows (see usage-events.ts for the same note).
 */
import { Hono } from "hono";
import { parseUsageEventPayload, insertUsageEvents } from "@oxagen/telemetry";
import { rateLimiter } from "../../middleware/rate-limit";
import { logger } from "../../middleware/logger";
import type { AppEnv } from "../../app";

export const telemetryUsageRoute = new Hono<AppEnv>();

// 60 requests/minute/IP: generous for legitimate CLI usage (at most one event
// per command invocation) while bounding abuse of a public, unauthed endpoint.
// Match only this subrouter's concrete endpoint. A wildcard here is cloned
// under the parent `/v1/telemetry` mount and would unintentionally throttle
// authenticated sibling routes such as `/v1/telemetry/stella/*`.
telemetryUsageRoute.use("/usage", rateLimiter({ windowMs: 60_000, max: 60 }));

telemetryUsageRoute.post("/usage", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(
      { error: "invalid_request", message: "Invalid JSON body" },
      400,
    );
  }

  // Defense in depth: parseUsageEventPayload's `.strict()` schema is the real
  // enforcement point (any key outside the allowlist, or any value outside
  // its validated shape, fails here) — see usage-events.ts.
  const result = parseUsageEventPayload(rawBody);
  if (!result.ok) {
    // result.error is a short, static "field + issue code" string — it never
    // echoes the submitted value, so attacker-supplied content is never
    // reflected back into a response body.
    return c.json({ error: "invalid_request", message: result.error }, 400);
  }

  try {
    await insertUsageEvents([
      { ...result.data, timestamp: new Date().toISOString() },
    ]);
  } catch (err) {
    logger.error({ err }, "[telemetry.usage] insert failed");
    return c.json(
      { error: "internal_error", message: "Failed to record event" },
      500,
    );
  }

  return c.json({ ok: true }, 200);
});

import { Hono } from "hono";
import { telemetryErrorCluster } from "@oxagen/oxagen/contracts/telemetry.error.cluster";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const telemetryErrorClusterRoute = new Hono<AppEnv>();

// GET /?sinceHours=&severity=&source=&limit= — cluster recent captured errors
// by fingerprint: the fleet-wide triage overview (pure SQL, no model call).
telemetryErrorClusterRoute.get("/", async (c) => {
  const sinceHoursRaw = c.req.query("sinceHours");
  const limitRaw = c.req.query("limit");
  const input = telemetryErrorCluster.input.parse({
    sinceHours: sinceHoursRaw !== undefined ? Number(sinceHoursRaw) : undefined,
    severity: c.req.query("severity") ?? undefined,
    source: c.req.query("source") ?? undefined,
    limit: limitRaw !== undefined ? Number(limitRaw) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(telemetryErrorCluster.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

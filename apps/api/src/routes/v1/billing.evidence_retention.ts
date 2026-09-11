import { Hono } from "hono";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const billingEvidenceRetentionRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/billing/evidence/retention
billingEvidenceRetentionRoute.get("/", async (c) => {
  const input = billingEvidenceRetention.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(billingEvidenceRetention.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});

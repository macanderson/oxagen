import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * configure_reseller_stripe — store the reseller's OWN Stripe secret key so pushes
 * bill from their account, not the platform's (vendor-neutral BYO-billing). The
 * key is encrypted at rest with the platform envelope; only its last 4 chars are
 * ever returned. Re-invoking replaces the stored key.
 *
 * Highest sensitivity: this writes a live payment credential. Never logged, never
 * echoed — the output carries only a non-secret fingerprint.
 */
export const resellerStripeConfigure = registerCapability({
  name: "configure_reseller_stripe",
  domain: "billing",
  description:
    "Store the reseller's own Stripe secret key (encrypted at rest) so re-bill pushes invoice from their account. Returns only a last-4 fingerprint, never the key.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "billing" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({
    /** A Stripe secret key (sk_live_… / sk_test_…). Stored encrypted; never returned. */
    secretKey: z.string().min(12).max(200),
    /** Optional human label for the connected account, shown in the UI. */
    accountLabel: z.string().max(200).nullable().optional(),
  }),
  output: z.object({
    connected: z.literal(true),
    accountLabel: z.string().nullable(),
    /** Last 4 chars of the stored key — the only fingerprint safe to show. */
    keyLast4: z.string(),
  }),
});

export type ResellerStripeConfigureInput = z.output<
  typeof resellerStripeConfigure.input
>;
export type ResellerStripeConfigureOutput = z.output<
  typeof resellerStripeConfigure.output
>;

import { z } from "zod";
import { registerCapability } from "../registry";

export const privacyDataErase = registerCapability({
  name: "erase_data",
  domain: "privacy",
  description:
    "Request erasure of personal or organizational data (GDPR Article 17 — right to erasure). Requires explicit confirmation. Revokes all sessions immediately; hard-delete is scheduled asynchronously. Emits a webhook event for downstream integrations.",
  mode: "async",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "privacy" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    // User-scope erasure: any authenticated user can erase their own account.
    // Org-scope erasure: Owner only (not Admin — too destructive).
    org: { Owner: "allow" },
    workspace: {},
  },
  input: z.object({
    /** "user" = current user's account + data; "org" = full org offboarding (Owner only). */
    scope: z.enum(["user", "org"]),
    /** Required when scope = "org". */
    orgId: z.string().uuid().optional(),
    /** Must be literally `true`. Acts as an explicit confirmation gate. */
    confirm: z.literal(true),
  }),
  output: z.object({
    requestId: z.string().uuid(),
    status: z.literal("queued"),
    /** ISO 8601 timestamp when the hard-delete is scheduled to execute. */
    effectiveAt: z.string().datetime(),
  }),
});

export type PrivacyDataEraseInput = z.output<typeof privacyDataErase.input>;
export type PrivacyDataEraseOutput = z.output<typeof privacyDataErase.output>;

import { z } from "zod";
import { registerCapability } from "../registry";

// Soft-delete an API key by setting its deletedAt timestamp. The key becomes
// invalid for all subsequent requests immediately (resolveApiKey filters on
// isNull(deletedAt)). The row is retained for audit purposes. Audited as
// api_key.revoked.
//
// Authorization: org Owner or Admin only.
export const apiKeyRevoke = registerCapability({
  name: "revoke_api_key",
  domain: "api_key",
  description:
    "Revoke an API key by its public ID or internal ID. The key is soft-deleted and immediately invalid. Audited as api_key.revoked.",
  mode: "sync",
  // See api.key.rotate.ts: the app's token page invokes on the "agent"
  // surface and the "app" layer below declares that page, so omitting the
  // surface made every revoke from the UI fail the kernel's surface gate.
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // API key management does not consume AI tokens — billing gate must not
  // block this for orgs with zero credit balance.
  noBillingGate: true,
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    keyPublicId: z
      .string()
      .min(1)
      .describe("The aky_* public ID of the API key to revoke"),
  }),
  output: z.object({
    revoked: z.boolean(),
    keyPublicId: z.string(),
    revokedAt: z.string().describe("ISO-8601 timestamp of revocation"),
  }),
});

export type ApiKeyRevokeInput = z.output<typeof apiKeyRevoke.input>;
export type ApiKeyRevokeOutput = z.output<typeof apiKeyRevoke.output>;

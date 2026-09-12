import { z } from "zod";
import { defineTool } from "./_define";
import { apiKeyRevoke } from "../api.key.revoke";

/**
 * Appendix E: `revoke_api_key` — absorbs `revoke_api_key`. Blank Does column:
 * the job is unchanged.
 *
 * A clean 1:1 carry. The behaviour behind it is worth restating because it is
 * what makes §7.4's halt stick: revocation is a soft delete that sets
 * `deletedAt`, the key is invalid on the very next request (key resolution
 * filters on `isNull(deletedAt)`), and the row is retained for audit. §6.2:
 * "Revoking the agent credential or suspending the agent invalidates every run
 * token at the next call."
 *
 * Like `rotate_api_key`, the `agent` surface is load-bearing rather than
 * decorative — the app's token page invokes on it, and dropping it made the
 * kernel's surface gate refuse every revocation from the UI.
 */
export const revokeApiKey = defineTool({
  name: "revoke_api_key",
  domain: "api_key",
  description:
    "Revoke an API key by its public ID. The key is soft-deleted and immediately invalid for every subsequent request; the row is retained for audit. Audited as api_key.revoked.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,

  absorbs: ["revoke_api_key"],
  drops: [],

  // Carried unchanged.
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
  // Carried, and here it matters most: an organization at zero credit balance
  // must still be able to revoke a leaked key.
  noBillingGate: true,
  mutates: true,

  input: z.object({
    keyPublicId: apiKeyRevoke.input.shape.keyPublicId,
  }),

  output: z.object({
    revoked: apiKeyRevoke.output.shape.revoked,
    keyPublicId: apiKeyRevoke.output.shape.keyPublicId,
    revokedAt: apiKeyRevoke.output.shape.revokedAt,
  }),
});

export type RevokeApiKeyInput = z.output<typeof revokeApiKey.input>;
export type RevokeApiKeyOutput = z.output<typeof revokeApiKey.output>;

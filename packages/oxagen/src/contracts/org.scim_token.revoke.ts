import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * revoke_scim_token: stop the identity provider pushing to Oxagen (#3734).
 *
 * The live token stops working at once. Nothing the identity provider already
 * provisioned changes: people keep their memberships and roles until an admin
 * or a later token says otherwise. Revoking when no token is live answers
 * `revoked: false` and writes nothing.
 *
 * Org Owner/Admin only. Open on every plan, so an organization that left the
 * Enterprise plan can still turn SCIM off. Audited as `scim.token_revoked`.
 */
export const orgScimTokenRevoke = registerCapability({
  name: "revoke_scim_token",
  domain: "org",
  description:
    "Revoke the organization's SCIM bearer token so the identity provider can no longer push users or groups. People already provisioned keep their access.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({}),
  output: z.object({
    revoked: z
      .boolean()
      .describe("False when no token was live, so nothing changed"),
  }),
});

export type OrgScimTokenRevokeInput = z.output<typeof orgScimTokenRevoke.input>;
export type OrgScimTokenRevokeOutput = z.output<
  typeof orgScimTokenRevoke.output
>;

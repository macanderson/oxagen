import { z } from "zod";
import { registerCapability } from "../registry";
import { scimTokenMintedSchema } from "./org.scim_token.shared";

/**
 * rotate_scim_token: replace the organization's SCIM token (#3734).
 *
 * One transaction revokes the live token and mints its replacement, so there
 * is never a moment with two live tokens or none. The old token stops
 * working at once; the identity provider needs the new one before its next
 * push. Works when no token is live too, which makes it the recovery path for
 * a token nobody wrote down.
 *
 * Org Owner/Admin only, Enterprise only, audited as `scim.token_rotated`. Not
 * on MCP, for the reason `create_scim_token` gives.
 */
export const orgScimTokenRotate = registerCapability({
  name: "rotate_scim_token",
  domain: "org",
  description:
    "Replace the organization's SCIM bearer token. The old token stops working immediately and the new one is returned once. Update the identity provider with the new token.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({}),
  output: scimTokenMintedSchema,
});

export type OrgScimTokenRotateInput = z.output<typeof orgScimTokenRotate.input>;
export type OrgScimTokenRotateOutput = z.output<
  typeof orgScimTokenRotate.output
>;

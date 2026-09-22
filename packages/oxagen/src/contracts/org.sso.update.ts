import { z } from "zod";
import { registerCapability } from "../registry";
import { refineSsoIssuer } from "./org.sso.create";
import {
  ssoGroupsClaimSchema,
  ssoProtocolUpdateInputSchema,
  ssoProviderIdSchema,
  ssoProviderViewSchema,
} from "./org.sso.shared";

/**
 * update_sso_provider: change a provider's display name, groups claim or
 * protocol settings (ADR-142).
 *
 * A secret left out of `config` keeps the sealed value already stored. The
 * domain cannot change, because verification binds the provider to it: to
 * move a provider to another domain, delete it and create a new one. The
 * protocol cannot change either. A new OIDC issuer is checked against its
 * discovery document before anything is written.
 *
 * Org Owner/Admin only, audited as `sso.provider_updated` with the fields the
 * change touched. No `agent` metadata.
 */
export const orgSsoUpdate = registerCapability({
  name: "update_sso_provider",
  domain: "org",
  description:
    "Change an SSO provider's display name, groups claim, or OIDC or SAML settings. A secret left out keeps the stored one. The domain and the protocol cannot change; delete the provider and create a new one instead. Returns the provider view.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({
    providerId: ssoProviderIdSchema,
    displayName: z.string().trim().min(1).max(120).optional(),
    groupsClaim: ssoGroupsClaimSchema.optional(),
    config: ssoProtocolUpdateInputSchema
      .superRefine(refineSsoIssuer)
      .optional(),
  }),
  output: z.object({ provider: ssoProviderViewSchema }),
});

export type OrgSsoUpdateInput = z.output<typeof orgSsoUpdate.input>;
export type OrgSsoUpdateOutput = z.output<typeof orgSsoUpdate.output>;

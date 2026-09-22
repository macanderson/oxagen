import { z } from "zod";
import { registerCapability } from "../registry";
import { ssoProviderIdSchema, ssoProviderViewSchema } from "./org.sso.shared";

/**
 * verify_sso_domain: prove the organisation owns the provider's email domain
 * by looking up the DNS TXT record the provider view names (ADR-142).
 *
 * The provider signs nobody in until this succeeds. A missing record is a
 * `conflict` whose message names the record to publish, so the admin can fix
 * DNS and retry.
 *
 * Org Owner/Admin only, audited as `sso.domain_verified`. No `agent` metadata.
 */
export const orgSsoVerifyDomain = registerCapability({
  name: "verify_sso_domain",
  domain: "org",
  description:
    "Check the DNS TXT record that proves the organisation owns an SSO provider's email domain, and mark the domain verified when the record matches. Returns the provider view.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({ providerId: ssoProviderIdSchema }),
  output: z.object({ provider: ssoProviderViewSchema }),
});

export type OrgSsoVerifyDomainInput = z.output<typeof orgSsoVerifyDomain.input>;
export type OrgSsoVerifyDomainOutput = z.output<
  typeof orgSsoVerifyDomain.output
>;

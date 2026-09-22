import { z } from "zod";
import { registerCapability } from "../registry";
import { ssoPolicyViewSchema, ssoProviderViewSchema } from "./org.sso.shared";

/**
 * list_sso_providers: the organisation's identity providers, each with its
 * group-to-role table, and whether SSO is required (ADR-142).
 *
 * No secret leaves: the view says whether a client secret or an SP private
 * key is stored, never what it is. The callback URL and, for SAML, the SP
 * metadata URL are what the admin copies into the identity provider.
 *
 * Organisation-level, org Owner/Admin only. No `agent` metadata: the in-app
 * agent never reads or changes how people sign in.
 */
export const orgSsoList = registerCapability({
  name: "list_sso_providers",
  domain: "org",
  description:
    "List the organisation's SSO identity providers (OIDC or SAML) with their domain verification record, callback URL, group-to-role mappings, and whether SSO is required. Secrets are never returned; the view says only whether one is stored.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  // Organisation-level governance: org Owner/Admin only. `workspace: {}` is
  // required by the declaration type and is deliberately empty.
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  // A read. The app's kernelRead refuses a contract without this flag
  // (`contract_mutates`), and the Single sign-on and Roles pages read it.
  mutates: false,
  input: z.object({}),
  output: z.object({
    providers: z.array(ssoProviderViewSchema),
    policy: ssoPolicyViewSchema,
  }),
});

export type OrgSsoListInput = z.output<typeof orgSsoList.input>;
export type OrgSsoListOutput = z.output<typeof orgSsoList.output>;

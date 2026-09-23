import { z } from "zod";
import { registerCapability } from "../registry";
import { ssoPolicyViewSchema } from "./org.sso.shared";

/**
 * set_sso_policy: require SSO for the organisation, or stop requiring it
 * (ADR-144).
 *
 * Turning the requirement on needs at least one provider whose domain is
 * verified, or nobody could meet it. Owners stay exempt so an IdP outage
 * cannot lock the organisation out. The MFA settings on the same policy row
 * are left as they are.
 *
 * Org Owner/Admin only, audited as `sso.policy_updated`. No `agent` metadata.
 */
export const orgSsoPolicySet = registerCapability({
  name: "set_sso_policy",
  domain: "org",
  description:
    "Require SSO for the organisation, or stop requiring it. While required, members other than Owners reach the organisation only through one of its SSO providers. Turning it on needs at least one provider with a verified domain.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({ ssoRequired: z.boolean() }),
  output: z.object({ policy: ssoPolicyViewSchema }),
});

export type OrgSsoPolicySetInput = z.output<typeof orgSsoPolicySet.input>;
export type OrgSsoPolicySetOutput = z.output<typeof orgSsoPolicySet.output>;

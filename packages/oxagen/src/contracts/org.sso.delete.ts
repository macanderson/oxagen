import { z } from "zod";
import { registerCapability } from "../registry";
import { ssoProviderIdSchema } from "./org.sso.shared";

/**
 * delete_sso_provider: remove an identity provider and its group-to-role
 * table (ADR-145).
 *
 * When SSO is required and this was the organisation's last verified
 * provider, the same transaction turns the requirement off, so nobody is left
 * needing a sign-in path that no longer exists. That change is audited as
 * `sso.policy_updated` beside the `sso.provider_deleted` row.
 *
 * Org Owner/Admin only. No `agent` metadata.
 */
export const orgSsoDelete = registerCapability({
  name: "delete_sso_provider",
  domain: "org",
  description:
    "Delete an SSO provider and its group-to-role mappings. If SSO is required and no verified provider remains, the requirement is turned off in the same change.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({ providerId: ssoProviderIdSchema }),
  output: z.object({ deleted: z.literal(true) }),
});

export type OrgSsoDeleteInput = z.output<typeof orgSsoDelete.input>;
export type OrgSsoDeleteOutput = z.output<typeof orgSsoDelete.output>;

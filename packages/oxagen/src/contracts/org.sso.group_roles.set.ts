import { z } from "zod";
import { registerCapability } from "../registry";
import { ssoGroupRoleSchema, ssoProviderIdSchema } from "./org.sso.shared";

/** At most 200 rows, and one role per group. */
export const ssoGroupRoleMappingsSchema = z
  .array(ssoGroupRoleSchema)
  .max(200)
  .superRefine((mappings, issues) => {
    const seen = new Set<string>();
    mappings.forEach((m, index) => {
      if (seen.has(m.group)) {
        issues.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "group"],
          message: `The group "${m.group}" is mapped twice. Give each group one role.`,
        });
      }
      seen.add(m.group);
    });
  });

/**
 * set_sso_group_roles: replace a provider's table of IdP group to
 * organisation role (ADR-144).
 *
 * The table is replaced whole: the rows sent are the rows kept. At sign-in
 * the highest-ranked role any of a person's groups maps to wins, and a person
 * whose groups map to nothing is granted nothing. `owner` cannot be mapped.
 *
 * Org Owner/Admin only, audited as `sso.group_roles_set` with the table after
 * the write. No `agent` metadata.
 */
export const orgSsoGroupRolesSet = registerCapability({
  name: "set_sso_group_roles",
  domain: "org",
  description:
    "Replace an SSO provider's mappings from identity-provider group to organisation role (admin, compliance, billing, or member). At sign-in the highest mapped role wins; unmapped groups grant nothing. Returns the mappings as stored.",
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
    mappings: ssoGroupRoleMappingsSchema,
  }),
  output: z.object({
    providerId: z.string(),
    mappings: z.array(ssoGroupRoleSchema),
  }),
});

export type OrgSsoGroupRolesSetInput = z.output<
  typeof orgSsoGroupRolesSet.input
>;
export type OrgSsoGroupRolesSetOutput = z.output<
  typeof orgSsoGroupRolesSet.output
>;

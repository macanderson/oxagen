import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * org.list — list the organizations (tenants) the authenticated user belongs to.
 *
 * Unscoped + user-level: a freshly-authenticated CLI user has no org selected
 * yet, so this is the first call the `oxagen login` / `oxagen init` linker makes
 * to present the tenant picker. Mirrors organization.create's pre-org posture
 * (scoped:false, mounted under the auth-only /v1 user group). The handler reads
 * the caller's own org_users memberships via withSystemDb — it never crosses to
 * another user's memberships.
 */
export const orgListItemSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  slug: z.string(),
  // Immutable, globally-unique namespace (the first segment of an agentKey).
  // Distinct from slug, which is renameable.
  namespace: z.string(),
  name: z.string(),
  role: z
    .string()
    .describe(
      "The caller's role in this org (lowercase, e.g. owner/admin/member)",
    ),
  avatarUrl: z.string().nullable(),
});

export const orgList = registerCapability({
  name: "list_orgs",
  domain: "org",
  description:
    "List the organizations (tenants) the authenticated user belongs to, with the caller's role in each. Backs the CLI tenant picker.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "organization",
  },
  sensitivity: "low",
  mutates: false,
  // allow by default: "list my own orgs" is a user-intrinsic right. Any
  // authenticated principal who passes the enterprise resolver without an
  // explicit deny policy must be allowed — the handler enforces that the
  // caller can only see memberships for their own user identity. Keeping
  // this as "deny" caused no_grant 403s for Enterprise-plan callers whose
  // org was created before org.list was added to the contract registry
  // (role_grants seeded by bootstrapOrgIAM are missing), because the
  // resolver correctly falls through to the contract defaultEffect when no
  // matching role-grant row exists. (OXA fix — CLI workspace picker 403.)
  defaultEffect: "allow",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Billing: "allow",
      Compliance: "allow",
      Viewer: "allow",
    },
    workspace: {},
  },
  input: z.object({}),
  output: z.object({
    organizations: z.array(orgListItemSchema),
  }),
});

export type OrgListItem = z.output<typeof orgListItemSchema>;
export type OrgListInput = z.output<typeof orgList.input>;
export type OrgListOutput = z.output<typeof orgList.output>;

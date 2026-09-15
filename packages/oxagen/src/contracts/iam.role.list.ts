import { z } from "zod";
import { registerCapability } from "../registry";
import { PERMISSION_GROUPS } from "../iam/permission-catalog";

/**
 * iam.role.list — read the org's IAM roles, grants, and assignment counts.
 *
 * The "permitted action" link of the accountability chain made human-readable:
 * which roles exist in this org, which capability grants each role carries
 * (allow / deny / require_approval), which catalogue permissions those grants
 * cover, and how many principals hold each role. The output carries the
 * permission catalogue the editor speaks and whether the kernel enforces
 * roles for this org's tier (ADR-057). `create_role`, `set_role_grants` and
 * `delete_role` are the writes.
 *
 * Powers the Organization › Roles page.
 */

const grantEffect = z.enum(["allow", "deny", "require_approval"]);

const roleGrantRow = z.object({
  capability: z.string().describe("Capability name the grant applies to"),
  effect: grantEffect,
});

/** Who a role can be held by: the human system roles, or an agent principal. */
export const roleKindSchema = z.enum(["human", "agent"]);

export const roleRow = z.object({
  id: z.string().describe("Public role id (rol_…)"),
  name: z.string(),
  description: z.string().nullable(),
  scopeKind: z.enum(["org", "workspace"]),
  kind: roleKindSchema.describe(
    "human for the seeded membership roles; agent for the seeded agent roles and every custom role, which only assign_agent_role binds",
  ),
  isSystemDefault: z
    .boolean()
    .describe(
      "True for system-seeded roles (Owner, Admin, …) — not user-deletable",
    ),
  version: z.string(),
  memberCount: z
    .number()
    .int()
    .describe(
      "Active (non-deleted, non-expired) principal assignments holding this role",
    ),
  grants: z
    .array(roleGrantRow)
    .describe(
      "Capability grants carried by the role (empty when includeGrants=false)",
    ),
  permissions: z
    .array(z.string())
    .describe(
      "Catalogue permission ids every capability of which the role allows (empty when includeGrants=false)",
    ),
  createdAt: z.string().describe("ISO-8601"),
  createdBy: z
    .string()
    .nullable()
    .describe("Display name of the user who created the role, when recorded"),
});

export const permissionCatalogEntry = z.object({
  id: z.string(),
  group: z.enum(PERMISSION_GROUPS),
  description: z.string(),
  capabilities: z.array(z.string()),
});

export const iamRoleList = registerCapability({
  name: "list_iam_roles",
  domain: "iam",
  description:
    "List the org's IAM roles with their capability grants (allow/deny/require_approval) and the number of principals assigned to each. Read-only — the human-readable face of the permitted-action link of the accountability chain.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Governance-posture reads must never be blocked by a zero credit balance.
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  // Role/grant configuration reveals the org's permission model — admin-level
  // but not credential material.
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: {},
  },
  input: z.object({
    scopeKind: z
      .enum(["org", "workspace"])
      .optional()
      .describe("Filter to roles of one scope kind (default: both)"),
    includeGrants: z
      .boolean()
      .default(true)
      .describe("Include each role's capability grant list (default true)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(100)
      .describe("Max roles to return"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
  }),
  output: z.object({
    roles: z
      .array(roleRow)
      .describe("Roles sorted system-defaults-first, then by name"),
    total: z
      .number()
      .int()
      .describe("Total roles matching the filter before pagination"),
    hasMore: z.boolean(),
    limit: z.number().int(),
    offset: z.number().int(),
    catalog: z
      .array(permissionCatalogEntry)
      .describe("The permission catalogue, in catalogue order"),
    enforcement: z
      .object({
        tier: z.string().describe("The org's plan tier"),
        enforced: z
          .boolean()
          .describe(
            "True when the kernel's IAM check runs the resolver for this org (the enterprise tier); false when every capability is allowed and the roles here are documentation",
          ),
      })
      .describe("Whether the roles listed govern anything for this org"),
  }),
});

export type IamRoleListInput = z.output<typeof iamRoleList.input>;
export type IamRoleListOutput = z.output<typeof iamRoleList.output>;
export type IamRoleRow = z.output<typeof roleRow>;

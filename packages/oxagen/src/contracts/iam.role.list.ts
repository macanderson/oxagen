import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * iam.role.list — read the org's IAM roles, grants, and assignment counts.
 *
 * The "permitted action" link of the accountability chain made human-readable:
 * which roles exist in this org, which capability grants each role carries
 * (allow / deny / require_approval), and how many principals hold each role.
 * Read-only — role and grant WRITES remain seed-script / provisioning-only
 * until dedicated write contracts are authored (ship-read-first).
 *
 * Powers the org Governance → Policies roles table.
 */

const grantEffect = z.enum(["allow", "deny", "require_approval"]);

const roleGrantRow = z.object({
  capability: z.string().describe("Capability name the grant applies to"),
  effect: grantEffect,
});

const roleRow = z.object({
  id: z.string().describe("Public role id (rol_…)"),
  name: z.string(),
  description: z.string().nullable(),
  scopeKind: z.enum(["org", "workspace"]),
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
  }),
});

export type IamRoleListInput = z.output<typeof iamRoleList.input>;
export type IamRoleListOutput = z.output<typeof iamRoleList.output>;
export type IamRoleRow = z.output<typeof roleRow>;

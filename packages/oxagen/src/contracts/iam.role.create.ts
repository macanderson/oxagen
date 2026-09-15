import { z } from "zod";
import { registerCapability } from "../registry";
import { PERMISSION_IDS } from "../iam/permission-catalog";
import { roleRow } from "./iam.role.list";

/** A role name: the mockup's `agent.release` shape, lower-case, dot-separated. */
export const roleNameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:[.\-_][a-z0-9]+)*$/,
    "lower-case letters, digits, and single . - _ separators",
  );

export const rolePermissionsSchema = z
  .array(z.enum(PERMISSION_IDS))
  .min(1, "A role with no permissions grants nothing — pick at least one")
  .describe("Catalogue permission ids the role allows (ADR-063)");

/**
 * create_role — a custom role from the permission catalogue (ADR-063).
 *
 * One `allow` grant is written per capability the chosen permissions name.
 * The handler refuses a granter who does not hold every one of those
 * capabilities (the delegation ceiling), an org whose tier does not run the
 * IAM resolver (`forbidden`, `enterprise_tier_required`: the kernel would
 * never read the role), and a name already taken in the same scope kind or,
 * for a custom role, in either scope kind (`conflict`, `role_exists`). Custom roles are agent roles: only
 * `assign_agent_role` binds them.
 */
export const iamRoleCreate = registerCapability({
  name: "create_role",
  domain: "iam",
  description:
    "Create a custom IAM role from the permission catalogue. Writes one allow grant per capability the chosen permissions name; refused above the granter's own permissions, for a tier the kernel does not enforce roles on, and for a name another role of the org already uses.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // A settings write, never a governed action (ADR-052 exclusion 2; INV-28).
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "iam" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    name: roleNameSchema.describe(
      "Immutable once created; prefix with the kind: agent., svc.",
    ),
    scopeKind: z
      .enum(["org", "workspace"])
      .describe(
        "org: assigned org-wide; workspace: assigned in one workspace at a time",
      ),
    description: z.string().max(500).nullable().default(null),
    permissions: rolePermissionsSchema,
  }),
  output: z.object({ role: roleRow }),
});

export type IamRoleCreateInput = z.output<typeof iamRoleCreate.input>;
export type IamRoleCreateOutput = z.output<typeof iamRoleCreate.output>;

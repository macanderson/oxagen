import { z } from "zod";
import { registerCapability } from "../registry";
import { rolePermissionsSchema } from "./iam.role.create";
import { roleRow } from "./iam.role.list";

/**
 * set_role_grants — replace a custom role's grants with the permission set
 * given (ADR-063).
 *
 * Every grant the role carried is removed and one `allow` grant per
 * capability the permissions name is written, in one transaction, so a
 * holder's next authorization sees the new set and nothing in between. The
 * handler refuses a system role (`conflict`, `system_role_readonly`) and a
 * granter who does not hold every capability named (the delegation
 * ceiling). No tier gates the write (ADR-067).
 */
export const iamRoleGrantsSet = registerCapability({
  name: "set_role_grants",
  domain: "iam",
  description:
    "Replace a custom IAM role's grants with a set of permissions from the catalogue. System roles are read-only; the new set is refused above the granter's own permissions.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
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
    roleId: z.string().startsWith("rol_").describe("Public role id (rol_…)"),
    permissions: rolePermissionsSchema,
  }),
  output: z.object({ role: roleRow }),
});

export type IamRoleGrantsSetInput = z.output<typeof iamRoleGrantsSet.input>;
export type IamRoleGrantsSetOutput = z.output<typeof iamRoleGrantsSet.output>;

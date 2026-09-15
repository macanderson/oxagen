import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * delete_role — remove a custom role nobody holds (ADR-057).
 *
 * The role row and its grants go; the audit record keeps the definition and
 * every grant it carried (the kernel's `capability.invoke_*` events). The
 * handler refuses a system role (`conflict`, `system_role_readonly`) and a
 * role with an active assignment (`conflict`, `role_in_use`, with the
 * count): a role is never deleted out from under a holder.
 */
export const iamRoleDelete = registerCapability({
  name: "delete_role",
  domain: "iam",
  description:
    "Delete a custom IAM role and its grants. Refused for a system role and for a role any principal still holds.",
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
  }),
  output: z.object({
    id: z.string().describe("The deleted role's public id"),
    name: z.string(),
  }),
});

export type IamRoleDeleteInput = z.output<typeof iamRoleDelete.input>;
export type IamRoleDeleteOutput = z.output<typeof iamRoleDelete.output>;

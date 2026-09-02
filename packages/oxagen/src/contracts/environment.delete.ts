import { z } from "zod";
import { registerCapability } from "../registry";

export const environmentDelete = registerCapability({
  name: "delete_environment",
  domain: "environment",
  description:
    "Soft-delete a workspace environment. The default environment cannot be deleted — promote another first.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "configuration",
  },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ environmentId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export type EnvironmentDeleteInput = z.output<typeof environmentDelete.input>;

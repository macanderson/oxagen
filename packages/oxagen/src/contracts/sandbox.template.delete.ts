import { z } from "zod";
import { registerCapability } from "../registry";

export const sandboxTemplateDelete = registerCapability({
  name: "delete_sandbox_template",
  domain: "sandbox",
  description:
    "Soft-delete a sandbox template. A default template cannot be deleted — promote another in the same environment first.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "configuration",
  },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ templateId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

export type SandboxTemplateDeleteInput = z.output<
  typeof sandboxTemplateDelete.input
>;

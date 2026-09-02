import { z } from "zod";
import { registerCapability } from "../registry";
import { sandboxTemplateSummarySchema } from "./sandbox.template.create";

export const sandboxTemplateSetDefault = registerCapability({
  name: "set_default_sandbox_template",
  domain: "sandbox",
  description:
    "Promote a sandbox template to its environment's default. Atomically swaps the existing default within that environment; the promoted template is reactivated.",
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
  output: z.object({ template: sandboxTemplateSummarySchema }),
});

export type SandboxTemplateSetDefaultInput = z.output<
  typeof sandboxTemplateSetDefault.input
>;
export type SandboxTemplateSetDefaultOutput = z.output<
  typeof sandboxTemplateSetDefault.output
>;

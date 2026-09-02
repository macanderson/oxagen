import { z } from "zod";
import { registerCapability } from "../registry";
import { sandboxTemplateToolSchema } from "./sandbox-template-manifest";
import { sandboxTemplateSummarySchema } from "./sandbox.template.create";

// The compound object ("template tools") is folded into a single verb-first
// name rather than split across segments, mirroring the existing
// set_default_sandbox_template / set_skill_enabled precedent.
export const sandboxTemplateSetTools = registerCapability({
  name: "set_sandbox_template_tools",
  domain: "sandbox",
  description:
    "Replace the full set of preloaded tools on a sandbox template (replace-set semantics — the given tools become the template's entire tool set).",
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
  input: z.object({
    templateId: z.string().min(1),
    tools: z.array(sandboxTemplateToolSchema),
  }),
  output: z.object({ template: sandboxTemplateSummarySchema }),
});

export type SandboxTemplateSetToolsInput = z.output<
  typeof sandboxTemplateSetTools.input
>;
export type SandboxTemplateSetToolsOutput = z.output<
  typeof sandboxTemplateSetTools.output
>;

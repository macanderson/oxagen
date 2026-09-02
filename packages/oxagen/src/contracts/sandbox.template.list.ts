import { z } from "zod";
import { registerCapability } from "../registry";
import { sandboxTemplateSummarySchema } from "./sandbox.template.create";

export const sandboxTemplateList = registerCapability({
  name: "list_sandbox_templates",
  domain: "sandbox",
  description:
    "List sandbox templates in the active workspace, optionally filtered to one environment.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ environmentId: z.string().min(1).optional() }),
  output: z.object({ templates: z.array(sandboxTemplateSummarySchema) }),
});

export type SandboxTemplateListInput = z.output<
  typeof sandboxTemplateList.input
>;
export type SandboxTemplateListOutput = z.output<
  typeof sandboxTemplateList.output
>;

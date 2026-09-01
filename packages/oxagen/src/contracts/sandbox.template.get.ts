import { z } from "zod";
import { registerCapability } from "../registry";
import { sandboxTemplateSummarySchema } from "./sandbox.template.create";

export const sandboxTemplateGet = registerCapability({
  name: "get_sandbox_template",
  domain: "sandbox",
  description: "Fetch a single sandbox template (with its tools) by its public id.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ templateId: z.string().min(1) }),
  output: z.object({ template: sandboxTemplateSummarySchema }),
});

export type SandboxTemplateGetOutput = z.output<typeof sandboxTemplateGet.output>;

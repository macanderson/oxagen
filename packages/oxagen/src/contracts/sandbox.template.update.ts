import { z } from "zod";
import { registerCapability } from "../registry";
import {
  sandboxProviderSchema,
  sandboxResourcesSchema,
  sandboxNetworkSchema,
  sandboxSecretSelectionSchema,
  sandboxLiteralEnvSchema,
} from "./sandbox-template-manifest";
import { sandboxTemplateSummarySchema } from "./sandbox.template.create";

export const sandboxTemplateUpdate = registerCapability({
  name: "update_sandbox_template",
  domain: "sandbox",
  description:
    "Update a sandbox template's metadata, provider, runtime, resources, network, secret selection, literal config, or active state. A default template cannot be deactivated — promote another first.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "medium", category: "configuration" },
  layers: ["api", "mcp", "unit", "docs", "app"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    templateId: z.string().min(1),
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    provider: sandboxProviderSchema.optional(),
    runtime: z.string().nullable().optional(),
    resources: sandboxResourcesSchema.optional(),
    network: sandboxNetworkSchema.optional(),
    secretSelection: sandboxSecretSelectionSchema.optional(),
    literalEnv: sandboxLiteralEnvSchema.optional(),
    isActive: z.boolean().optional(),
  }),
  output: z.object({ template: sandboxTemplateSummarySchema }),
});

export type SandboxTemplateUpdateInput = z.output<typeof sandboxTemplateUpdate.input>;
export type SandboxTemplateUpdateOutput = z.output<typeof sandboxTemplateUpdate.output>;

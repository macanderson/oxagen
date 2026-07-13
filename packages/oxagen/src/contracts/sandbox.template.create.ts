import { z } from "zod";
import { registerCapability } from "../registry";
import {
  sandboxProviderSchema,
  sandboxResourcesSchema,
  sandboxNetworkSchema,
  sandboxSecretSelectionSchema,
  sandboxLiteralEnvSchema,
  sandboxTemplatePackagesSchema,
  sandboxTemplateToolSchema,
  sandboxToolKindSchema,
} from "./sandbox-template-manifest";

/** A tool row as returned by every template read/write. */
export const sandboxTemplateToolSummarySchema = z.object({
  id: z.string(),
  kind: sandboxToolKindSchema,
  ref: z.string(),
  config: z.record(z.string(), z.unknown()),
});

/** Shared template shape returned by every sandbox.template.* read/write. */
export const sandboxTemplateSummarySchema = z.object({
  id: z.string(),
  environmentId: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  provider: sandboxProviderSchema,
  runtime: z.string().nullable(),
  resources: sandboxResourcesSchema,
  network: sandboxNetworkSchema,
  secretSelection: sandboxSecretSelectionSchema,
  literalEnv: sandboxLiteralEnvSchema,
  packages: sandboxTemplatePackagesSchema,
  tools: z.array(sandboxTemplateToolSummarySchema),
});

export const sandboxTemplateCreate = registerCapability({
  name: "create_sandbox_template",
  domain: "sandbox",
  description:
    "Create a portable sandbox template under an environment: provider, runtime image, resources, network posture, selected vault keys, literal config, and preloaded tools.",
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
    environmentId: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().nullable().optional(),
    provider: sandboxProviderSchema.optional(),
    runtime: z.string().nullable().optional(),
    resources: sandboxResourcesSchema.optional(),
    network: sandboxNetworkSchema.optional(),
    secretSelection: sandboxSecretSelectionSchema.optional(),
    literalEnv: sandboxLiteralEnvSchema.optional(),
    packages: sandboxTemplatePackagesSchema.optional(),
    tools: z.array(sandboxTemplateToolSchema).optional(),
    setAsDefault: z.boolean().optional(),
  }),
  output: z.object({ template: sandboxTemplateSummarySchema }),
});

export type SandboxTemplateCreateInput = z.output<
  typeof sandboxTemplateCreate.input
>;
export type SandboxTemplateCreateOutput = z.output<
  typeof sandboxTemplateCreate.output
>;

import { z } from "zod";
import { registerCapability } from "../registry";

/** Shared environment shape returned by every environment.* read/write. */
export const environmentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
});

export const environmentCreate = registerCapability({
  name: "create_environment",
  domain: "environment",
  description:
    "Create a workspace environment (e.g. production, development, preview) for scoping secrets and sandbox config.",
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
  input: z.object({
    name: z.string().min(1),
    slug: z.string().min(1),
    description: z.string().nullable().optional(),
  }),
  output: z.object({ environment: environmentSummarySchema }),
});

export type EnvironmentCreateInput = z.output<typeof environmentCreate.input>;
export type EnvironmentCreateOutput = z.output<typeof environmentCreate.output>;

import { z } from "zod";
import { registerCapability } from "../registry";
import { environmentSummarySchema } from "./environment.create";

export const environmentUpdate = registerCapability({
  name: "update_environment",
  domain: "environment",
  description:
    "Update a workspace environment's name, slug, description, or active state. The default environment cannot be deactivated.",
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
    environmentId: z.string().min(1),
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  }),
  output: z.object({ environment: environmentSummarySchema }),
});

export type EnvironmentUpdateInput = z.output<typeof environmentUpdate.input>;
export type EnvironmentUpdateOutput = z.output<typeof environmentUpdate.output>;

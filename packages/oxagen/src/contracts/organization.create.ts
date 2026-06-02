import { z } from "zod";
import { registerCapability } from "../registry";

export const organizationCreate = registerCapability({
  name: "organization.create",
  domain: "organization",
  description: "Create a new organization with a globally-unique slug",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: false,
  agent: { requiresApproval: true, riskLevel: "medium", category: "organization" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only"),
    planSlug: z.string().min(1).default("free"),
  }),
  output: z.object({
    publicId: z.string(),
    name: z.string(),
    slug: z.string(),
    createdAt: z.string(),
  }),
});

export type OrganizationCreateInput = z.output<typeof organizationCreate.input>;
export type OrganizationCreateOutput = z.output<typeof organizationCreate.output>;

import { z } from "zod";
import { registerCapability } from "../registry.js";

export const tenantCreate = registerCapability({
  name: "tenant.create",
  domain: "organization",
  description: "Create a new tenant with a globally-unique slug",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: false,
  agent: { requiresApproval: true, riskLevel: "medium", category: "organization" },
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

export type TenantCreateInput = z.infer<typeof tenantCreate.input>;
export type TenantCreateOutput = z.infer<typeof tenantCreate.output>;

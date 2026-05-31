import { z } from "zod";
import { registerCapability } from "../registry.js";

export const workspaceCreate = registerCapability({
  name: "workspace.create",
  domain: "workspace",
  description: "Create a workspace within the active tenant",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "workspace" },
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only"),
  }),
  output: z.object({
    publicId: z.string(),
    name: z.string(),
    slug: z.string(),
    orgSlug: z.string(),
    createdAt: z.string(),
  }),
});

export type WorkspaceCreateInput = z.output<typeof workspaceCreate.input>;
export type WorkspaceCreateOutput = z.output<typeof workspaceCreate.output>;

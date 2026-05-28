import { z } from "zod";
import { registerCapability } from "../registry.js";

export const workspaceCreate = registerCapability({
  name: "workspace.create",
  domain: "workspace",
  description: "Create a workspace within the active tenant",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
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
    tenantSlug: z.string(),
    createdAt: z.string(),
  }),
});

export type WorkspaceCreateInput = z.infer<typeof workspaceCreate.input>;
export type WorkspaceCreateOutput = z.infer<typeof workspaceCreate.output>;

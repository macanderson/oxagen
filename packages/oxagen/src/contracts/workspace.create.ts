import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * create_workspace — a workspace in the caller's org.
 *
 * The handler bootstraps the workspace (its namespace, the creator's Owner
 * membership, its registry seed) and refuses a slug already used in the org
 * (`conflict`, `slug_taken`). Org Owners and Admins, and a workspace Owner
 * calling from a workspace, are checked in the handler (INV-29).
 */
export const workspaceCreate = registerCapability({
  name: "create_workspace",
  domain: "workspace",
  description:
    "Create a workspace within the active tenant. Refused for a slug already used in the organization.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // A settings write, never a governed action (ADR-052 exclusion 2; INV-28).
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "workspace" },
  sensitivity: "medium",
  mutates: true,
  defaultEffect: "deny",
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

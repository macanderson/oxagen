import { z } from "zod";
import { registerCapability } from "../registry";

export const workspaceMemberList = registerCapability({
  name: "list_workspace_members",
  domain: "workspace",
  description: "List members of a workspace",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    workspace_id: z.string().optional(),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      role: z.string(),
      joined_at: z.string(),
    }),
  ),
});

export type WorkspaceMemberListInput = z.output<
  typeof workspaceMemberList.input
>;
export type WorkspaceMemberListOutput = z.output<
  typeof workspaceMemberList.output
>;

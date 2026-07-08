import { z } from "zod";
import { registerCapability } from "../registry";

export const skillWorkspaceList = registerCapability({
  name: "list_workspace_skills",
  aliases: ["skill.workspace.list"],
  domain: "skill",
  description: "List skills available in the workspace",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    workspace_id: z.string().optional(),
  }),
  output: z.object({
    skills: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        enabled: z.boolean(),
      }),
    ),
  }),
});

export type SkillWorkspaceListInput = z.output<typeof skillWorkspaceList.input>;
export type SkillWorkspaceListOutput = z.output<typeof skillWorkspaceList.output>;

import { z } from "zod";
import { registerCapability } from "../registry";

export const skillEnable = registerCapability({
  name: "set_skill_enabled",
  domain: "skill",
  description:
    "Enable or disable a skill in the workspace. Disabled skills are hidden from the agent and excluded from tool materialization, but their versions and data are preserved.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    skill_id: z
      .string()
      .describe("Public ID of the skill (skl_...) or its slug"),
    enabled: z.boolean().describe("true to enable, false to disable"),
    workspace_id: z
      .string()
      .optional()
      .describe("Workspace ID (defaults to current workspace)"),
  }),
  output: z.object({
    skill_id: z.string().describe("Public ID of the skill"),
    slug: z.string().describe("Skill slug"),
    enabled: z.boolean().describe("New enabled state"),
  }),
});

export type SkillEnableInput = z.output<typeof skillEnable.input>;
export type SkillEnableOutput = z.output<typeof skillEnable.output>;

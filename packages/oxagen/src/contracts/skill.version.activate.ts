import { z } from "zod";
import { registerCapability } from "../registry";

export const skillVersionActivate = registerCapability({
  name: "activate_skill_version",
  domain: "skill",
  description:
    "Re-point a skill's active version to a chosen (possibly older) skill_versions row. Sets activated_by_user_id and activated_at on the skill row. Exactly one version is active at any time per skill.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    skillId: z
      .string()
      .describe("Public ID of the skill (e.g. 'skl_...') or its slug"),
    versionNumber: z
      .number()
      .int()
      .min(1)
      .describe("Version number to activate"),
  }),
  output: z.object({
    skillId: z.string().describe("Public ID of the skill"),
    activeVersionNumber: z.number().int().describe("Version number now active"),
    activatedAt: z.string().describe("ISO 8601 timestamp of activation"),
  }),
});

export type SkillVersionActivateInput = z.output<
  typeof skillVersionActivate.input
>;
export type SkillVersionActivateOutput = z.output<
  typeof skillVersionActivate.output
>;

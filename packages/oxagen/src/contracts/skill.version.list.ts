import { z } from "zod";
import { registerCapability } from "../registry";

export const skillVersionList = registerCapability({
  name: "list_skill_versions",
  domain: "skill",
  description:
    "List the time-ordered version history for a workspace skill, including version number, active status, latest flag, author, and timestamp",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    skill_id: z.string().describe("Public skill ID (skl_…) or its slug"),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .default(20)
      .describe("Maximum number of versions to return (default 20, max 100)"),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Pagination offset (number of versions to skip)"),
  }),
  output: z.object({
    skill_id: z.string(),
    versions: z.array(
      z.object({
        id: z.string().describe("Public version ID (slv_…)"),
        versionNumber: z.number().int(),
        isLatest: z.boolean(),
        isActive: z
          .boolean()
          .describe(
            "True when this version matches the skill's active_version_id",
          ),
        changeSummary: z
          .string()
          .nullable()
          .describe("Author-supplied summary of what changed in this version"),
        createdAt: z.string().datetime(),
        createdBy: z
          .string()
          .nullable()
          .describe("User ID who created this version"),
        createdByEmail: z
          .string()
          .nullable()
          .describe("Email of the author, when resolvable"),
      }),
    ),
    total: z.number().int().describe("Total number of versions for this skill"),
  }),
});

export type SkillVersionListInput = z.output<typeof skillVersionList.input>;
export type SkillVersionListOutput = z.output<typeof skillVersionList.output>;

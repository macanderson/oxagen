import { z } from "zod";
import { registerCapability } from "../registry";

export const skillEdit = registerCapability({
  name: "edit_skill",
  domain: "skill",
  description:
    "Save an edited skill body as a new immutable version. Thin wrapper over the shared createNewSkillVersion helper — equivalent to skill.version.upload but accepts a skill_id and body directly from an inline editor.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "skill" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    skill_id: z
      .string()
      .describe("Public ID of the skill to edit (skl_…) or its slug"),
    body: z
      .string()
      .min(1)
      .describe("Full updated .skill.md content including YAML frontmatter"),
    change_summary: z
      .string()
      .max(500)
      .optional()
      .describe("Author-supplied summary of what changed (commit message)"),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Set the new version as active immediately (default: true)"),
    workspace_id: z
      .string()
      .optional()
      .describe("Workspace ID (defaults to current workspace)"),
  }),
  output: z.object({
    version_id: z
      .string()
      .describe("Public ID of the new skill version (slv_…)"),
    version_number: z
      .number()
      .int()
      .describe("Monotonically increasing version number"),
    skill_id: z.string().describe("Public ID of the parent skill"),
    activated: z
      .boolean()
      .describe("Whether this version is now the active version"),
  }),
});

export type SkillEditInput = z.output<typeof skillEdit.input>;
export type SkillEditOutput = z.output<typeof skillEdit.output>;

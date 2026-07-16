import { z } from "zod";
import { registerCapability } from "../registry";

export const skillVersionUpload = registerCapability({
  name: "upload_skill_version",
  domain: "skill",
  description:
    "Upload a new immutable skill version from raw .skill.md content. Creates a new version row, marks it as latest, and sets it as the skill's active version (unless activate=false).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "app"],
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
      .describe(
        "Public ID of the skill to add a version to (skl_…) or its slug",
      ),
    body: z
      .string()
      .min(1)
      .describe("Raw .skill.md content including YAML frontmatter"),
    change_summary: z
      .string()
      .max(500)
      .optional()
      .describe("Author-supplied summary of what changed (commit message)"),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Set this version as active immediately (default: true)"),
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

export type SkillVersionUploadInput = z.output<typeof skillVersionUpload.input>;
export type SkillVersionUploadOutput = z.output<
  typeof skillVersionUpload.output
>;

import { z } from "zod";
import { registerCapability } from "../registry";

export const skillRevise = registerCapability({
  name: "revise_skill",
  domain: "skill",
  description:
    "AI-driven edit of an existing skill: take a plain-language description of the change you want and the skill's current body, have the model redesign the .skill.md body (and description/weight) accordingly, then save it as a NEW immutable version — the version number is bumped and, by default, activated. The skill's identity (slug) never changes. This is the edit counterpart to skill.author (AI-create). Returns the new version id/number, whether it was activated, and a human-readable change summary.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "skill" },
  sensitivity: "medium",
  defaultEffect: "deny",
  // Mirrors skill.edit — the version-bump path this composes onto.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    skill_id: z
      .string()
      .describe("Public ID of the skill to revise (skl_…)."),
    prompt: z
      .string()
      .min(10)
      .max(4000)
      .describe(
        "Plain-language description of the change to make — e.g. 'tighten the incident-response steps to five bullets and add a rollback section'. At least 10 characters.",
      ),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Set the new version as the skill's active version immediately (default: true). Pass false to stage the revision without going live.",
      ),
    workspace_id: z
      .string()
      .optional()
      .describe("Workspace ID (defaults to the current workspace)."),
  }),
  output: z.object({
    skill_id: z.string().describe("Public ID of the parent skill (skl_…)."),
    version_id: z.string().describe("Public ID of the new skill version (slv_…)."),
    version_number: z
      .number()
      .int()
      .positive()
      .describe("The newly-created (bumped) version number."),
    activated: z
      .boolean()
      .describe("Whether this version is now the skill's active version."),
    body: z
      .string()
      .describe("The revised .skill.md content (YAML frontmatter + body)."),
    changeSummary: z
      .array(z.string())
      .default([])
      .describe(
        "Short human-readable bullets of what changed versus the prior version, for a diff line in the UI.",
      ),
  }),
});

export type SkillReviseInput = z.output<typeof skillRevise.input>;
export type SkillReviseOutput = z.output<typeof skillRevise.output>;

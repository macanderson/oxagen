import { z } from "zod";
import { registerCapability } from "../registry";

export const skillCreate = registerCapability({
  name: "skill.create",
  domain: "skill",
  description:
    "Create a new tenant-authored skill in the workspace. Inserts a skills row with source='tenant' and an initial version (v1). Returns the skill public ID, slug, and version. Idempotent on slug — if a skill with the same slug already exists, returns it unchanged.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "skill" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(100)
      .describe("Human-readable name for the skill"),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "Must be kebab-case (a-z, 0-9, hyphens)")
      .describe("Unique kebab-case identifier for the skill within this workspace"),
    description: z
      .string()
      .max(500)
      .optional()
      .describe("Short description of what the skill teaches the agent"),
    body: z
      .string()
      .min(1)
      .max(32_000)
      .describe("Full .skill.md content (YAML frontmatter + markdown body)"),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Set the initial version as active immediately (default: true)"),
    workspace_id: z.string().optional().describe("Workspace ID (defaults to current workspace)"),
  }),
  output: z.object({
    publicId: z.string().describe("Public ID of the skill (skl_...)"),
    slug: z.string().describe("Kebab-case slug"),
    activeVersion: z.number().int().positive().describe("Active version number (1 for new)"),
    created: z
      .boolean()
      .describe("true if newly created, false if slug already existed (idempotent)"),
  }),
});

export type SkillCreateInput = z.output<typeof skillCreate.input>;
export type SkillCreateOutput = z.output<typeof skillCreate.output>;

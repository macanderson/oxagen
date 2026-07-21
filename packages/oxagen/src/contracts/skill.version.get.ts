import { z } from "zod";
import { skillArtifactSchema } from "@oxagen/agent-artifacts";
import { registerCapability } from "../registry";

export const skillVersionGet = registerCapability({
  name: "get_skill_version",
  domain: "skill",
  description:
    "Fetch a specific immutable workspace skill version with canonical TOML and its parsed artifact projection",
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
    version_id: z
      .string()
      .optional()
      .describe(
        "Public version ID (slv_…). Omit to get the skill's pinned active version (falling back to latest when no version is pinned)",
      ),
  }),
  output: z.object({
    id: z.string().describe("Public version ID (slv_…)"),
    skill_id: z.string(),
    // Parent-skill metadata so a detail surface can render skill + version
    // from one call (the app detail route resolves by slug with no prior id).
    skill_slug: z.string().describe("Workspace-unique skill slug"),
    skill_name: z.string(),
    skill_description: z
      .string()
      .describe("Skill description (empty string when unset)"),
    skill_source: z
      .string()
      .describe('"builtin" | "tenant" (+ future provenance)'),
    installedFromSlug: z
      .string()
      .nullable()
      .describe(
        "Builtin/template slug this skill was installed from, when applicable",
      ),
    versionNumber: z.number().int(),
    isLatest: z.boolean(),
    isActive: z
      .boolean()
      .describe("True when this version matches the skill's active_version_id"),
    content: z.string().describe("Canonical skill.toml content"),
    artifact: skillArtifactSchema,
    referencesPayload: z
      .array(z.unknown())
      .describe("Graph node + file references projected from the artifact"),
    changeSummary: z
      .string()
      .nullable()
      .describe("Author-supplied summary of what changed in this version"),
    checksum: z
      .string()
      .nullable()
      .describe("SHA-256 hex over content; null on rows predating checksums"),
    createdAt: z.string().datetime(),
    createdBy: z
      .string()
      .nullable()
      .describe("User ID who created this version"),
  }),
});

export type SkillVersionGetInput = z.output<typeof skillVersionGet.input>;
export type SkillVersionGetOutput = z.output<typeof skillVersionGet.output>;

import { z } from "zod";
import { registerCapability } from "../registry";

export const skillWorkspaceInstall = registerCapability({
  name: "install_skill",
  domain: "skill",
  description:
    "Install a skill into a workspace — copies a builtin template (by slug) or a custom upload into a workspace-owned agent.skills row with skill_versions v1 (is_latest=true). Idempotent on slug.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    // Install a named builtin template from packages/skills by its slug.
    // Mutually exclusive with `custom`; at least one must be provided.
    slug: z.string().min(1).optional(),
    // Install a custom (uploaded) skill definition. Mutually exclusive with `slug`.
    custom: z
      .object({
        content: z.string().min(1).describe("Canonical skill.toml content"),
      })
      .optional(),
    workspace_id: z.string().optional(),
  }),
  output: z.object({
    publicId: z.string(),
    slug: z.string(),
    activeVersion: z.number().int().positive(),
    installed: z
      .boolean()
      .describe("false when the skill already existed (idempotent)"),
  }),
});

export type SkillWorkspaceInstallInput = z.output<
  typeof skillWorkspaceInstall.input
>;
export type SkillWorkspaceInstallOutput = z.output<
  typeof skillWorkspaceInstall.output
>;

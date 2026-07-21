import { z } from "zod";
import { registerCapability } from "../registry";

export const skillAuthor = registerCapability({
  name: "author_skill",
  domain: "skill",
  description:
    "Author a new skill from a natural-language prompt, serialize canonical TOML, validate it, and install it into the workspace",
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
    prompt: z
      .string()
      .min(10)
      .max(4000)
      .describe(
        "Natural-language description of what the skill should teach the agent. At least 10 characters.",
      ),
    nameHint: z
      .string()
      .regex(/^[a-z0-9-]+$/, "kebab-case slug only (a–z, 0–9, -)")
      .optional()
      .describe(
        "Optional preferred slug for the skill (kebab-case, e.g. 'code-review'). The model will derive one from the prompt if omitted.",
      ),
    category: z
      .string()
      .optional()
      .describe(
        "Optional category label (e.g. 'engineering', 'writing', 'meta').",
      ),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Activate the new skill version immediately (default: true)."),
    workspace_id: z
      .string()
      .optional()
      .describe(
        "Workspace ID to install the skill into (defaults to the current workspace).",
      ),
  }),
  output: z.object({
    publicId: z.string().describe("Public ID of the installed skill (skl_…)"),
    slug: z.string().describe("Kebab-case slug of the installed skill"),
    content: z.string().describe("The generated canonical skill.toml content"),
    activeVersion: z
      .number()
      .int()
      .positive()
      .describe("Active version number after installation"),
    installed: z
      .boolean()
      .describe(
        "true if a new skill was created, false if an identically-slugged skill already existed (idempotent)",
      ),
  }),
});

export type SkillAuthorInput = z.output<typeof skillAuthor.input>;
export type SkillAuthorOutput = z.output<typeof skillAuthor.output>;

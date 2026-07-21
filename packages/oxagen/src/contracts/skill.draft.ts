import { z } from "zod";
import { skillArtifactSchema } from "@oxagen/agent-artifacts";
import { registerCapability } from "../registry";

export const skillDraft = registerCapability({
  name: "draft_skill",
  domain: "skill",
  description:
    "Draft a skill configuration from a natural-language description without persisting anything. The model synthesises the full skill shape — display name, kebab-case slug, matcher description, weight, optional category, and the markdown body — and returns it for human review. Feed the confirmed draft to skill.create (or skill.workspace.install with a custom body) to save it. This is the AI-assisted first step of the skill setup flow.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
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
  }),
  output: z.object({
    draft: z
      .object({
        displayName: z
          .string()
          .describe("Human-readable skill title (e.g. 'Incident Response')"),
        slug: z.string().describe("Kebab-case slug derived by the model"),
        description: z
          .string()
          .describe(
            "One-sentence matcher description used to decide when to load the skill",
          ),
        weight: z
          .enum(["low", "high", "critical"])
          .describe("Influence weight for the skill's guidance"),
        category: z
          .string()
          .optional()
          .describe("Category label, when the model assigned one"),
        body: z
          .string()
          .describe(
            "The instruction text embedded in the canonical TOML artifact",
          ),
      })
      .describe(
        "The synthesised skill configuration, ready to prefill a review form",
      ),
    content: z
      .string()
      .describe("Canonical skill.toml content ready for create_skill"),
    artifact: skillArtifactSchema,
  }),
});

export type SkillDraftInput = z.output<typeof skillDraft.input>;
export type SkillDraftOutput = z.output<typeof skillDraft.output>;

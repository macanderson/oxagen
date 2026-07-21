import { z } from "zod";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";

// ── Shared skill synthesis shape ──────────────────────────────────────────────
// Used by both skill.author (generate → install) and skill.draft (generate →
// return for human review). The model synthesises this structure; callers
// assemble canonical TOML from it and validate with the shared artifact schema before
// persisting or returning it.

export const synthesisSchema = z.object({
  displayName: z
    .string()
    .min(1)
    .max(100)
    .describe("Human-readable skill title (e.g. 'PR Review')"),
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/, "kebab-case slug only")
    .min(1)
    .max(80)
    .describe("Kebab-case slug for the skill (e.g. 'pr-review')"),
  description: z
    .string()
    .min(10)
    .max(280)
    .describe(
      "One sentence a model can match against — what this skill is for and when to load it",
    ),
  weight: z
    .enum(["low", "high", "critical"])
    .describe(
      "Influence weight: low (soft guidance), high (strong guidance), critical (never violate)",
    ),
  category: z
    .string()
    .optional()
    .describe("Category label (e.g. 'engineering', 'writing', 'meta')"),
  body: z.string().min(50).describe("The instructions that teach the skill"),
});

export type SkillSynthesis = z.infer<typeof synthesisSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

const SKILL_ANATOMY = `
A skill is a directory bundle with a canonical skill.toml manifest.

MANIFEST FIELDS:
- schema_version: 1.
- kind: "skill".
- name: kebab-case slug (a–z, 0–9, -). This is the skill's identity.
- description: one sentence the model uses to decide whether to load the skill. State WHAT it covers AND when to reach for it.
- metadata.weight: "low" (soft guidance) | "high" (strong default) | "critical" (hard rule).
- metadata.category: free-text grouping (engineering, writing, meta, ...).
- references: explicit relative sidecar paths; leave empty unless supporting files exist.

WRITING RULES FOR THE BODY:
1. Open with when to load this skill — confirm the reader is in the right place.
2. Lead each section with the RULE, then the REASON. Model acts on the rule; reason guides edge cases.
3. Be specific and imperative. "Paginate every list endpoint" beats "consider performance".
4. Stay generic and reusable — write for any project that fits the topic.
5. Keep it short and focused. Aim for one topic, roughly one to two pages.
6. Return ONLY the instruction body — TOML is serialized deterministically after synthesis.
`.trim();

export function buildSystemPrompt(
  nameHint: string | undefined,
  category: string | undefined,
): string {
  return [
    "You are an expert skill author. Given a natural-language prompt, synthesise a complete skill",
    "for an AI agent system.",
    "",
    "SKILL ANATOMY:",
    SKILL_ANATOMY,
    "",
    nameHint ? `Preferred slug (use if it fits): ${nameHint}` : "",
    category ? `Preferred category: ${category}` : "",
    "",
    "RULES FOR YOUR RESPONSE:",
    "- Return a JSON object with fields: displayName, name, description, weight, category (optional), body.",
    "- displayName is the human-readable title (e.g. 'PR Review').",
    "- name MUST match /^[a-z0-9-]+$/ — kebab-case only, no underscores or spaces.",
    "- description must be ONE sentence (≤280 chars) that uniquely identifies this skill.",
    "- body is the instruction text only; do not wrap it in a second TOML document.",
    "- Do not add a References section unless the prompt explicitly mentions supporting files.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Canonical TOML assembler ──────────────────────────────────────────────────

export function assembleSkillToml(synthesis: SkillSynthesis): string {
  return serializeArtifactToml({
    schema_version: 1,
    kind: "skill",
    name: synthesis.name,
    description: synthesis.description,
    instructions: synthesis.body.trim(),
    references: [],
    metadata: {
      weight: synthesis.weight,
      ...(synthesis.category ? { category: synthesis.category } : {}),
    },
  });
}

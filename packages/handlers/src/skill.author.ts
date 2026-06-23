import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import { skillAuthor } from "@oxagen/oxagen/contracts/skill.author";
import { parseSkill } from "@oxagen/skills";
import { logger } from "./logger";

// ── Generated skill shape ─────────────────────────────────────────────────────
// The model synthesises this structure; we assemble the .skill.md string from it
// and validate with parseSkill before writing anything to the database.

const synthesisSchema = z.object({
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
    .describe("Influence weight: low (soft guidance), high (strong guidance), critical (never violate)"),
  category: z
    .string()
    .optional()
    .describe("Category label (e.g. 'engineering', 'writing', 'meta')"),
  body: z
    .string()
    .min(50)
    .describe("The markdown body that teaches the skill (everything after the frontmatter)"),
});

// ── System prompt ─────────────────────────────────────────────────────────────

const SKILL_ANATOMY = `
A skill is a single .skill.md file: a YAML frontmatter block followed by a markdown body.

FRONTMATTER FIELDS:
- name: kebab-case slug (a–z, 0–9, -). This is the skill's identity.
- description: one sentence the model uses to decide whether to load the skill. State WHAT it covers AND when to reach for it.
- metadata.weight: "low" (soft guidance) | "high" (strong default) | "critical" (hard rule).
- metadata.category: free-text grouping (engineering, writing, meta, ...).

WRITING RULES FOR THE BODY:
1. Open with when to load this skill — confirm the reader is in the right place.
2. Lead each section with the RULE, then the REASON. Model acts on the rule; reason guides edge cases.
3. Be specific and imperative. "Paginate every list endpoint" beats "consider performance".
4. Stay generic and reusable — write for any project that fits the topic.
5. Keep it short and focused. Aim for one topic, roughly one to two pages.
6. Return ONLY the body markdown (no frontmatter) — the frontmatter is synthesised separately.
`.trim();

function buildSystemPrompt(nameHint: string | undefined, category: string | undefined): string {
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
    "- Return a JSON object with fields: name, description, weight, category (optional), body.",
    "- name MUST match /^[a-z0-9-]+$/ — kebab-case only, no underscores or spaces.",
    "- description must be ONE sentence (≤280 chars) that uniquely identifies this skill.",
    "- body is the markdown body only, WITHOUT frontmatter.",
    "- Do not add a References section unless the prompt explicitly mentions supporting files.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── .skill.md assembler ───────────────────────────────────────────────────────

function assembleSkillMd(synthesis: z.infer<typeof synthesisSchema>): string {
  const metaLines: string[] = [`  weight: ${synthesis.weight}`];
  if (synthesis.category) metaLines.push(`  category: ${synthesis.category}`);

  const frontmatter = [
    "---",
    `name: ${synthesis.name}`,
    `description: ${synthesis.description}`,
    "metadata:",
    ...metaLines,
    "---",
  ].join("\n");

  return `${frontmatter}\n\n${synthesis.body.trim()}\n`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const skillAuthorHandler: CapabilityHandler<typeof skillAuthor> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error("[skill.author] workspaceId is required (scoped capability)");
  }

  const messageId = ctx.messageId ?? ctx.requestId;
  const systemPrompt = buildSystemPrompt(input.nameHint, input.category);

  // ── Step 1: synthesise skill structure from the prompt ────────────────────
  let synthesis: z.infer<typeof synthesisSchema>;
  try {
    const result = await generateObjectFor({
      schema: synthesisSchema,
      system: systemPrompt,
      prompt: `Skill prompt: ${input.prompt}`,
      temperature: 0.3,
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId,
      },
    });
    synthesis = result.object;
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "skill.author: generateObjectFor failed",
    );
    throw new Error(`[skill.author] Model synthesis failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 2: assemble and validate the .skill.md string ───────────────────
  const body = assembleSkillMd(synthesis);

  // parseSkill throws if frontmatter is missing or malformed — this guards
  // against a model returning a slug that violates the kebab-case schema.
  parseSkill(body, { source: "tenant" });

  // ── Step 3: persist via the existing transactional installer ─────────────
  const installResult = (await invoke(
    "skill.workspace.install",
    {
      custom: {
        name: synthesis.name,
        body,
      },
      workspace_id: input.workspace_id,
    },
    ctx,
  )) as { publicId: string; slug: string; activeVersion: number; installed: boolean };

  logger.info(
    {
      slug: synthesis.name,
      publicId: installResult.publicId,
      installed: installResult.installed,
      workspaceId: ctx.workspaceId,
      orgId: ctx.orgId,
      surface: ctx.surface,
    },
    "skill.author: completed",
  );

  return {
    publicId: installResult.publicId,
    slug: installResult.slug,
    body,
    activeVersion: installResult.activeVersion,
    installed: installResult.installed,
  };
};

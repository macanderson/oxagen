/**
 * skill.revise — AI-driven edit of an existing skill.
 *
 * The edit counterpart to skill.author (AI-create). Reads the skill's current
 * active-version body, has the model redesign it from a plain-language change
 * request (reusing the shared skill-synthesis schema + system prompt), pins the
 * skill's immutable slug, then saves the result as a NEW immutable version via
 * the shared createNewSkillVersion helper — the same version-bump path
 * skill.edit and skill.version.upload use. The new version is activated by
 * default; pass activate:false to stage it without going live.
 */
import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillRevise } from "@oxagen/oxagen/contracts/skill.revise";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { canonicalizeSkillArtifact } from "./skill-artifact";
import {
  assembleSkillToml,
  buildSystemPrompt,
  synthesisSchema,
  type SkillSynthesis,
} from "./skill-synthesis";
import { createNewSkillVersion } from "./skill-version-create";

/** Thrown for revise-specific preconditions (skill or active version not found). */
export class SkillReviseError extends Error {
  readonly code = "skill_revise_failed";
  constructor(message: string) {
    super(message);
    this.name = "SkillReviseError";
  }
}

// Shared skill synthesis, extended with a change summary the model fills
// describing exactly what it altered versus the current body.
const reviseSynthesisSchema = synthesisSchema.extend({
  changeSummary: z
    .array(z.string())
    .describe(
      "Short bullets stating exactly what you changed versus the CURRENT SKILL body shown — one bullet per change.",
    ),
});
type ReviseSkillSynthesis = z.infer<typeof reviseSynthesisSchema>;

interface CurrentSkill {
  slug: string;
  body: string;
}

/** Resolve a skill's slug + its active (or, failing that, latest) version body,
 *  scoped to the tenant — mirrors skill.version.get's resolution. */
async function loadCurrentSkill(
  skillPublicId: string,
  workspaceId: string,
): Promise<CurrentSkill> {
  return withTenantDb(async (tx) => {
    const [skillRow] = await tx
      .select({
        id: schema.skills.id,
        slug: schema.skills.slug,
        activeVersionId: schema.skills.activeVersionId,
      })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.publicId, skillPublicId),
          eq(schema.skills.workspaceId, workspaceId),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1);

    if (!skillRow) {
      throw new SkillReviseError(`Skill not found: ${skillPublicId}`);
    }

    // Prefer the pinned active version; fall back to the latest one so a skill
    // with no explicit active version can still be revised.
    const [versionRow] = skillRow.activeVersionId
      ? await tx
          .select({ body: schema.skillVersions.body })
          .from(schema.skillVersions)
          .where(eq(schema.skillVersions.id, skillRow.activeVersionId))
          .limit(1)
      : await tx
          .select({ body: schema.skillVersions.body })
          .from(schema.skillVersions)
          .where(eq(schema.skillVersions.skillId, skillRow.id))
          .orderBy(desc(schema.skillVersions.versionNumber))
          .limit(1);

    if (!versionRow) {
      throw new SkillReviseError(
        `Skill "${skillPublicId}" has no versions to revise.`,
      );
    }

    return { slug: skillRow.slug, body: versionRow.body };
  });
}

export const skillReviseHandler: CapabilityHandler<typeof skillRevise> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    throw new SkillReviseError("workspaceId is required (scoped capability).");
  }

  const messageId = ctx.messageId ?? ctx.requestId;

  // ── Load the current skill body + immutable slug ─────────────────────────────
  const current = await loadCurrentSkill(input.skill_id, ctx.workspaceId);
  const currentArtifact = canonicalizeSkillArtifact(current.body).artifact;
  const currentCategory = currentArtifact.metadata?.category;
  const categoryHint =
    typeof currentCategory === "string" ? currentCategory : undefined;

  // The system prompt is the shared skill-authoring guidance; nameHint pins the
  // existing slug so the model keeps the skill's identity.
  const systemPrompt = buildSystemPrompt(current.slug, categoryHint);

  const prompt = [
    "CURRENT SKILL (canonical TOML — revise this while preserving anything the change request does not touch):",
    current.body,
    "",
    "CHANGE REQUEST:",
    input.prompt,
    "",
    `Return the COMPLETE revised skill. The name (slug) MUST stay "${current.slug}" — it is the skill's fixed identity.`,
    "Fill `changeSummary` with one bullet per change you made versus the current body.",
  ].join("\n");

  // ── Synthesis ────────────────────────────────────────────────────────────────
  let synthesis: ReviseSkillSynthesis;
  try {
    const result = await generateObjectFor({
      schema: reviseSynthesisSchema,
      system: systemPrompt,
      prompt,
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
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        skillId: input.skill_id,
      },
      "skill.revise: generateObjectFor failed",
    );
    throw new SkillReviseError(
      `Model synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Pin identity: the slug is immutable, never let the model rename it ────────
  const pinned: SkillSynthesis = {
    ...synthesis,
    name: current.slug,
    // Preserve the current category when the model dropped it.
    category: synthesis.category ?? categoryHint,
  };
  const { content } = canonicalizeSkillArtifact(assembleSkillToml(pinned));

  // ── Persist as a new immutable version via the shared version-bump helper ────
  const result = await createNewSkillVersion({
    skillPublicId: input.skill_id,
    content,
    activate: input.activate,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId ?? null,
  });

  logger.info(
    {
      skillId: input.skill_id,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      activated: result.activated,
      changes: synthesis.changeSummary.length,
      surface: ctx.surface,
    },
    "skill.revise: new version created",
  );

  return {
    skill_id: result.skillId,
    version_id: result.versionId,
    version_number: result.versionNumber,
    activated: result.activated,
    content,
    changeSummary: synthesis.changeSummary,
  };
};

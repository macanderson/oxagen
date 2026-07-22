import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillDraft } from "@oxagen/oxagen/contracts/skill.draft";
import { logger } from "./logger";
import { canonicalizeSkillArtifact } from "./skill-artifact";
import {
  assembleSkillToml,
  buildSystemPrompt,
  synthesisSchema,
  type SkillSynthesis,
} from "./skill-synthesis";

// skill.draft is the human-in-the-loop half of skill.author: it runs the same
// synthesis but persists NOTHING. The caller (e.g. the app's skill setup
// wizard) presents the draft for review and saves via skill.create once the
// user confirms.

export const skillDraftHandler: CapabilityHandler<typeof skillDraft> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[skill.draft] workspaceId is required (scoped capability)",
    );
  }

  const messageId = ctx.messageId ?? ctx.requestId;
  const systemPrompt = buildSystemPrompt(input.nameHint, input.category);

  let synthesis: SkillSynthesis;
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
      "skill.draft: generateObjectFor failed",
    );
    throw new Error(
      `[skill.draft] Model synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { artifact, content } = canonicalizeSkillArtifact(
    assembleSkillToml(synthesis),
  );

  logger.info(
    {
      slug: synthesis.name,
      workspaceId: ctx.workspaceId,
      orgId: ctx.orgId,
      surface: ctx.surface,
    },
    "skill.draft: completed",
  );

  return {
    draft: {
      displayName: synthesis.displayName,
      slug: synthesis.name,
      description: synthesis.description,
      weight: synthesis.weight,
      category: synthesis.category,
      body: synthesis.body.trim(),
    },
    content,
    artifact,
  };
};

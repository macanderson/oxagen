import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import { skillAuthor } from "@oxagen/oxagen/contracts/skill.author";
import { parseSkill } from "@oxagen/skills";
import { logger } from "./logger";
import {
  assembleSkillMd,
  buildSystemPrompt,
  synthesisSchema,
  type SkillSynthesis,
} from "./skill-synthesis";

// The synthesis shape, system prompt, and .skill.md assembler are shared with
// skill.draft (the review-before-save variant) — see ./skill-synthesis.ts.

// ── Handler ───────────────────────────────────────────────────────────────────

export const skillAuthorHandler: CapabilityHandler<typeof skillAuthor> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error("[skill.author] workspaceId is required (scoped capability)");
  }

  const messageId = ctx.messageId ?? ctx.requestId;
  const systemPrompt = buildSystemPrompt(input.nameHint, input.category);

  // ── Step 1: synthesise skill structure from the prompt ────────────────────
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

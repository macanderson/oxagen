import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillEdit } from "@oxagen/oxagen/contracts/skill.edit";
import { logger } from "./logger";
import { createNewSkillVersion } from "./skill-version-create";

export const skillEditHandler: CapabilityHandler<typeof skillEdit> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "skill.edit: rejected — no authenticated user",
    );
    throw new Error("skill.edit requires an authenticated user");
  }

  const result = await createNewSkillVersion({
    skillPublicId: input.skill_id,
    content: input.content,
    changeSummary: input.change_summary,
    activate: input.activate,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
  });

  logger.info(
    {
      skillId: input.skill_id,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      activate: input.activate,
      surface: ctx.surface,
    },
    "skill.edit: completed",
  );

  return {
    version_id: result.versionId,
    version_number: result.versionNumber,
    skill_id: result.skillId,
    activated: result.activated,
  };
};

import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillVersionUpload } from "@oxagen/oxagen/contracts/skill.version.upload";
import { logger } from "./logger";
import { createNewSkillVersion } from "./skill-version-create";

export const skillVersionUploadHandler: CapabilityHandler<
  typeof skillVersionUpload
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "skill.version.upload: rejected — no authenticated user",
    );
    throw new Error("skill.version.upload requires an authenticated user");
  }

  const result = await createNewSkillVersion({
    skillPublicId: input.skill_id,
    body: input.body,
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
    "skill.version.upload: completed",
  );

  return {
    version_id: result.versionId,
    version_number: result.versionNumber,
    skill_id: result.skillId,
    activated: result.activated,
  };
};

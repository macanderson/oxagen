import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillVersionActivate } from "@oxagen/oxagen/contracts/skill.version.activate";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, or } from "drizzle-orm";
import { logger } from "./logger";

export const skillVersionActivateHandler: CapabilityHandler<
  typeof skillVersionActivate
> = async (input, ctx) => {
  const { skillId, versionNumber } = input;
  const now = new Date();

  const result = await withTenantDb(async (tx) => {
    // 1. Resolve the skill by publicId or slug within this tenant's workspace
    //    (same dual resolution as skill.enable).
    const [skill] = await tx
      .select({
        id: schema.skills.id,
        publicId: schema.skills.publicId,
        workspaceId: schema.skills.workspaceId,
        orgId: schema.skills.orgId,
      })
      .from(schema.skills)
      .where(
        and(
          or(
            eq(schema.skills.publicId, skillId),
            eq(schema.skills.slug, skillId),
          ),
          eq(schema.skills.workspaceId, ctx.workspaceId),
          eq(schema.skills.orgId, ctx.orgId),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1);

    if (!skill) {
      throw new Error(`[skill.version.activate] skill not found: ${skillId}`);
    }

    // 2. Resolve the target skill_version by (skillId, versionNumber) within tenant.
    const [targetVersion] = await tx
      .select({
        id: schema.skillVersions.id,
        versionNumber: schema.skillVersions.versionNumber,
        orgId: schema.skillVersions.orgId,
        workspaceId: schema.skillVersions.workspaceId,
      })
      .from(schema.skillVersions)
      .where(
        and(
          eq(schema.skillVersions.skillId, skill.id),
          eq(schema.skillVersions.versionNumber, versionNumber),
          eq(schema.skillVersions.orgId, ctx.orgId),
          eq(schema.skillVersions.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);

    if (!targetVersion) {
      throw new Error(
        `[skill.version.activate] version ${versionNumber} not found for skill ${skillId}`,
      );
    }

    // 3. Re-point the skill's active_version_id and populate audit columns.
    await tx
      .update(schema.skills)
      .set({
        activeVersionId: targetVersion.id,
        activatedByUserId: ctx.userId ?? null,
        activatedAt: now,
        updatedAt: now,
        updatedByUserId: ctx.userId ?? null,
      })
      .where(eq(schema.skills.id, skill.id));

    return {
      skillPublicId: skill.publicId,
      activeVersionNumber: targetVersion.versionNumber,
    };
  });

  logger.info(
    {
      skillId,
      versionNumber,
      workspaceId: ctx.workspaceId,
      orgId: ctx.orgId,
      userId: ctx.userId,
      surface: ctx.surface,
    },
    "skill.version.activate: activated",
  );

  return {
    skillId: result.skillPublicId,
    activeVersionNumber: result.activeVersionNumber,
    activatedAt: now.toISOString(),
  };
};

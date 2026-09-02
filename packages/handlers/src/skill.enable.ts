import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillEnable } from "@oxagen/oxagen/contracts/skill.enable";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { logger } from "./logger";

export const skillEnableHandler: CapabilityHandler<typeof skillEnable> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[skill.enable] workspaceId is required (scoped capability)",
    );
  }

  const { skill_id, enabled } = input;
  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;

  // Resolve the skill by public ID or slug
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.skills.id,
        publicId: schema.skills.publicId,
        slug: schema.skills.slug,
        enabled: schema.skills.enabled,
      })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.workspaceId, workspaceId),
          isNull(schema.skills.deletedAt),
          or(
            eq(schema.skills.publicId, skill_id),
            eq(schema.skills.slug, skill_id),
          ),
        ),
      )
      .limit(1),
  );

  const skill = rows[0];
  if (!skill) {
    throw new Error(
      `[skill.enable] Skill "${skill_id}" not found in this workspace`,
    );
  }

  // If already in desired state, return early (idempotent)
  if (skill.enabled === enabled) {
    return {
      skill_id: skill.publicId,
      slug: skill.slug,
      enabled: skill.enabled,
    };
  }

  // Update the enabled state
  await withTenantDb((tx) =>
    tx
      .update(schema.skills)
      .set({
        enabled,
        updatedAt: sql`now()`,
        updatedByUserId: ctx.userId ?? undefined,
      })
      .where(eq(schema.skills.id, skill.id)),
  );

  logger.info(
    {
      skillId: skill.publicId,
      slug: skill.slug,
      enabled,
      workspaceId,
      surface: ctx.surface,
    },
    `skill.enable: ${enabled ? "enabled" : "disabled"}`,
  );

  return {
    skill_id: skill.publicId,
    slug: skill.slug,
    enabled,
  };
};

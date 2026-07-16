import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillVersionList } from "@oxagen/oxagen/contracts/skill.version.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, desc, count, or } from "drizzle-orm";
import { logger } from "./logger";

export const skillVersionListHandler: CapabilityHandler<
  typeof skillVersionList
> = async (input, ctx) => {
  // Resolve the skill row by publicId or slug (same dual resolution as
  // skill.enable) to get the internal UUID and active version.
  const [skillRow] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.skills.id,
        publicId: schema.skills.publicId,
        activeVersionId: schema.skills.activeVersionId,
      })
      .from(schema.skills)
      .where(
        and(
          or(
            eq(schema.skills.publicId, input.skill_id),
            eq(schema.skills.slug, input.skill_id),
          ),
          eq(schema.skills.workspaceId, ctx.workspaceId),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!skillRow) {
    logger.warn(
      { skill_id: input.skill_id, workspaceId: ctx.workspaceId },
      "skill.version.list: skill not found",
    );
    return { skill_id: input.skill_id, versions: [], total: 0 };
  }

  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;

  // Fetch total count.
  const [countRow] = await withTenantDb((tx) =>
    tx
      .select({ total: count() })
      .from(schema.skillVersions)
      .where(
        and(
          eq(schema.skillVersions.skillId, skillRow.id),
          eq(schema.skillVersions.workspaceId, ctx.workspaceId),
        ),
      ),
  );

  const total = countRow?.total ?? 0;

  // Fetch version page, newest first. LEFT JOIN the author for display email
  // (nullable — system-created rows and removed users resolve to null).
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.skillVersions.publicId,
        versionNumber: schema.skillVersions.versionNumber,
        isLatest: schema.skillVersions.isLatest,
        id: schema.skillVersions.id,
        changeSummary: schema.skillVersions.changeSummary,
        createdAt: schema.skillVersions.createdAt,
        createdByUserId: schema.skillVersions.createdByUserId,
        createdByEmail: schema.users.email,
      })
      .from(schema.skillVersions)
      .leftJoin(
        schema.users,
        eq(schema.skillVersions.createdByUserId, schema.users.id),
      )
      .where(
        and(
          eq(schema.skillVersions.skillId, skillRow.id),
          eq(schema.skillVersions.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(desc(schema.skillVersions.versionNumber))
      .limit(limit)
      .offset(offset),
  );

  logger.info(
    {
      skill_id: input.skill_id,
      workspaceId: ctx.workspaceId,
      count: rows.length,
      total,
      surface: ctx.surface,
    },
    "skill.version.list: returned versions",
  );

  return {
    skill_id: skillRow.publicId,
    versions: rows.map((r) => ({
      id: r.publicId,
      versionNumber: r.versionNumber,
      isLatest: r.isLatest,
      isActive:
        skillRow.activeVersionId != null && r.id === skillRow.activeVersionId,
      changeSummary: r.changeSummary ?? null,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdByUserId ?? null,
      createdByEmail: r.createdByEmail ?? null,
    })),
    total,
  };
};

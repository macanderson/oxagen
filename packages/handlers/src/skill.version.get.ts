import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillVersionGet } from "@oxagen/oxagen/contracts/skill.version.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, or } from "drizzle-orm";
import { logger } from "./logger";
import { canonicalizeSkillArtifact } from "./skill-artifact";

export const skillVersionGetHandler: CapabilityHandler<
  typeof skillVersionGet
> = async (input, ctx) => {
  // Resolve the skill row by publicId or slug (same dual resolution as
  // skill.enable) to get the internal UUID, display metadata, and pin.
  const [skillRow] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.skills.id,
        publicId: schema.skills.publicId,
        slug: schema.skills.slug,
        name: schema.skills.name,
        description: schema.skills.description,
        source: schema.skills.source,
        installedFromSlug: schema.skills.installedFromSlug,
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
      "skill.version.get: skill not found",
    );
    throw new Error(`Skill not found: ${input.skill_id}`);
  }

  // Resolve the target version: explicit version_id when given, else the
  // pinned active version, else the latest (mirrors load_skill / skill.export).
  const versionColumns = {
    id: schema.skillVersions.id,
    publicId: schema.skillVersions.publicId,
    versionNumber: schema.skillVersions.versionNumber,
    isLatest: schema.skillVersions.isLatest,
    body: schema.skillVersions.body,
    referencesPayload: schema.skillVersions.referencesPayload,
    changeSummary: schema.skillVersions.changeSummary,
    checksum: schema.skillVersions.checksum,
    createdAt: schema.skillVersions.createdAt,
    createdByUserId: schema.skillVersions.createdByUserId,
  };

  const versionWhere = input.version_id
    ? and(
        eq(schema.skillVersions.publicId, input.version_id),
        eq(schema.skillVersions.skillId, skillRow.id),
        eq(schema.skillVersions.workspaceId, ctx.workspaceId),
      )
    : skillRow.activeVersionId
      ? and(
          eq(schema.skillVersions.id, skillRow.activeVersionId),
          eq(schema.skillVersions.workspaceId, ctx.workspaceId),
        )
      : and(
          eq(schema.skillVersions.skillId, skillRow.id),
          eq(schema.skillVersions.isLatest, true),
          eq(schema.skillVersions.workspaceId, ctx.workspaceId),
        );

  const [versionRow] = await withTenantDb((tx) =>
    tx
      .select(versionColumns)
      .from(schema.skillVersions)
      .where(versionWhere)
      .limit(1),
  );

  if (!versionRow) {
    logger.warn(
      {
        skill_id: input.skill_id,
        version_id: input.version_id ?? null,
        workspaceId: ctx.workspaceId,
      },
      "skill.version.get: version not found",
    );
    throw new Error(
      input.version_id
        ? `Skill version not found: ${input.version_id}`
        : `No version found for skill: ${input.skill_id}`,
    );
  }

  const { artifact, content } = canonicalizeSkillArtifact(versionRow.body);
  const isActive =
    skillRow.activeVersionId != null &&
    versionRow.id === skillRow.activeVersionId;

  logger.info(
    {
      skill_id: input.skill_id,
      version_id: input.version_id ?? null,
      versionNumber: versionRow.versionNumber,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
    },
    "skill.version.get: fetched version",
  );

  return {
    id: versionRow.publicId,
    skill_id: skillRow.publicId,
    skill_slug: skillRow.slug,
    skill_name: skillRow.name,
    skill_description: skillRow.description ?? "",
    skill_source: skillRow.source,
    installedFromSlug: skillRow.installedFromSlug ?? null,
    versionNumber: versionRow.versionNumber,
    isLatest: versionRow.isLatest,
    isActive,
    content,
    artifact,
    referencesPayload: Array.isArray(versionRow.referencesPayload)
      ? versionRow.referencesPayload
      : [],
    changeSummary: versionRow.changeSummary ?? null,
    checksum: versionRow.checksum ?? null,
    createdAt: versionRow.createdAt.toISOString(),
    createdBy: versionRow.createdByUserId ?? null,
  };
};

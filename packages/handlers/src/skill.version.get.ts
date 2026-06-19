import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillVersionGet } from "@oxagen/oxagen/contracts/skill.version.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { logger } from "./logger";

// Frontmatter delimiter — matches the FRONTMATTER_RE in packages/skills/src/loader.ts.
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;

function extractFrontmatter(body: string): Record<string, unknown> {
  const match = FRONTMATTER_RE.exec(body);
  if (!match) return {};
  return (parseYaml(match[1] ?? "") as Record<string, unknown>) ?? {};
}

export const skillVersionGetHandler: CapabilityHandler<typeof skillVersionGet> = async (
  input,
  ctx,
) => {
  // Resolve the skill row by publicId to get the internal UUID and active version.
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
          eq(schema.skills.publicId, input.skill_id),
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

  // Resolve the specific version row by publicId, scoped to the skill.
  const [versionRow] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.skillVersions.id,
        publicId: schema.skillVersions.publicId,
        skillId: schema.skillVersions.skillId,
        versionNumber: schema.skillVersions.versionNumber,
        isLatest: schema.skillVersions.isLatest,
        body: schema.skillVersions.body,
        referencesPayload: schema.skillVersions.referencesPayload,
        createdAt: schema.skillVersions.createdAt,
        createdByUserId: schema.skillVersions.createdByUserId,
      })
      .from(schema.skillVersions)
      .where(
        and(
          eq(schema.skillVersions.publicId, input.version_id),
          eq(schema.skillVersions.skillId, skillRow.id),
          eq(schema.skillVersions.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );

  if (!versionRow) {
    logger.warn(
      {
        skill_id: input.skill_id,
        version_id: input.version_id,
        workspaceId: ctx.workspaceId,
      },
      "skill.version.get: version not found",
    );
    throw new Error(`Skill version not found: ${input.version_id}`);
  }

  const frontmatter = extractFrontmatter(versionRow.body);
  const isActive =
    skillRow.activeVersionId != null && versionRow.id === skillRow.activeVersionId;

  logger.info(
    {
      skill_id: input.skill_id,
      version_id: input.version_id,
      versionNumber: versionRow.versionNumber,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
    },
    "skill.version.get: fetched version",
  );

  return {
    id: versionRow.publicId,
    skill_id: skillRow.publicId,
    versionNumber: versionRow.versionNumber,
    isLatest: versionRow.isLatest,
    isActive,
    body: versionRow.body,
    frontmatter,
    referencesPayload: Array.isArray(versionRow.referencesPayload)
      ? versionRow.referencesPayload
      : [],
    createdAt: versionRow.createdAt.toISOString(),
    createdBy: versionRow.createdByUserId ?? null,
  };
};

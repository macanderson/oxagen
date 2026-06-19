/**
 * createNewSkillVersion — shared helper for skill.version.upload and skill.edit.
 *
 * Shared codepath rules (OXA-1748):
 * - Creates a NEW immutable skill_versions row (versionNumber = max + 1).
 * - Sets is_latest = true on the new row and clears is_latest on the prior
 *   latest row (partial-unique index on skill_versions enforces one is_latest
 *   per skill).
 * - By default also sets skills.active_version_id to the new version; caller
 *   can opt out with activate=false.
 * - Prior version rows are NEVER modified beyond clearing is_latest.
 * - All writes are inside a single withTenantDb transaction.
 */
import { schema, withTenantDb } from "@oxagen/database";
import { parseSkill } from "@oxagen/skills";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import { logger } from "./logger";

export interface CreateSkillVersionOptions {
  /** Public ID of the skill (skl_…) */
  skillPublicId: string;
  /** Raw .skill.md body (must include YAML frontmatter) */
  body: string;
  /** Whether to set this version as the skill's active_version_id. Default: true */
  activate: boolean;
  orgId: string;
  workspaceId: string;
  userId: string | null;
}

export interface CreatedSkillVersion {
  versionId: string;
  versionNumber: number;
  skillId: string;
  activated: boolean;
}

export async function createNewSkillVersion(
  opts: CreateSkillVersionOptions,
): Promise<CreatedSkillVersion> {
  const { skillPublicId, body, activate, orgId, workspaceId, userId } = opts;

  // Validate the body is parseable before touching the DB.
  parseSkill(body, { source: "tenant" });

  return withTenantDb(async (tx) => {
    // 1. Resolve skill internal UUID from publicId within this tenant scope.
    const [skillRow] = await tx
      .select({ id: schema.skills.id, publicId: schema.skills.publicId })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.publicId, skillPublicId),
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.workspaceId, workspaceId),
          isNull(schema.skills.deletedAt),
        ),
      );

    if (!skillRow) {
      throw new Error(`skill.version: skill not found: ${skillPublicId}`);
    }

    // 2. Determine next version number.
    const [maxRow] = await tx
      .select({ maxVersion: max(schema.skillVersions.versionNumber) })
      .from(schema.skillVersions)
      .where(eq(schema.skillVersions.skillId, skillRow.id));

    const nextVersion = (maxRow?.maxVersion ?? 0) + 1;

    // 3. Clear is_latest on the existing latest version (if any).
    //    The partial unique index (WHERE is_latest = true) enforces uniqueness,
    //    so we must clear first within the transaction before inserting.
    await tx
      .update(schema.skillVersions)
      .set({ isLatest: false })
      .where(
        and(
          eq(schema.skillVersions.skillId, skillRow.id),
          eq(schema.skillVersions.isLatest, true),
        ),
      );

    // 4. Insert the new immutable version row.
    const [newVersion] = await tx
      .insert(schema.skillVersions)
      .values({
        orgId,
        workspaceId,
        skillId: skillRow.id,
        body,
        versionNumber: nextVersion,
        isLatest: true,
        parentVersionId: null,
        publishedAt: new Date(),
        referencesPayload: sql`'[]'::jsonb`,
        createdByUserId: userId ?? undefined,
        updatedByUserId: userId ?? undefined,
      })
      .returning({
        id: schema.skillVersions.id,
        publicId: schema.skillVersions.publicId,
        versionNumber: schema.skillVersions.versionNumber,
      });

    if (!newVersion) throw new Error("skill.version: insert returned no row");

    // 5. Optionally promote to active version on the parent skill.
    if (activate) {
      await tx
        .update(schema.skills)
        .set({
          activeVersionId: newVersion.id,
          activatedByUserId: userId ?? undefined,
          activatedAt: new Date(),
          updatedByUserId: userId ?? undefined,
        })
        .where(eq(schema.skills.id, skillRow.id));
    }

    logger.info(
      {
        skillPublicId,
        skillId: skillRow.id,
        versionPublicId: newVersion.publicId,
        versionNumber: newVersion.versionNumber,
        activate,
        orgId,
        workspaceId,
      },
      "createNewSkillVersion: version created",
    );

    return {
      versionId: newVersion.publicId,
      versionNumber: newVersion.versionNumber,
      skillId: skillPublicId,
      activated: activate,
    };
  });
}

/**
 * createNewSkillVersion — shared helper for skill.version.upload and skill.edit.
 *
 * Shared codepath rules:
 * - Creates a NEW immutable skill_versions row (versionNumber = max + 1).
 * - Sets is_latest = true on the new row and clears is_latest on the prior
 *   latest row (partial-unique index on skill_versions enforces one is_latest
 *   per skill).
 * - Records lineage: parent_version_id points at the prior latest row.
 * - references_payload is re-derived from the submitted artifact, so each entry
 *   carries its path with an EMPTY body. Reference bodies are resolved once at
 *   install/seed time and are not re-resolvable server-side for a tenant edit,
 *   so an edit currently drops the prior version's resolved bodies rather than
 *   carrying them forward. The prior row's payload is read below but not merged;
 *   restoring the carry-forward is a behavioral change that needs its own
 *   change (skill.version.upload.test.ts pins today's empty-body output).
 * - Stamps checksum = SHA-256 hex over body (immutability contract, mirrors
 *   agent_versions.checksum).
 * - By default also sets skills.active_version_id to the new version; caller
 *   can opt out with activate=false.
 * - Prior version rows are NEVER modified beyond clearing is_latest.
 * - All writes are inside a single withTenantDb transaction.
 */
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, max, or } from "drizzle-orm";
import { skillBodyChecksum } from "./skill-checksum";
import { logger } from "./logger";
import { canonicalizeSkillArtifact } from "./skill-artifact";

export interface CreateSkillVersionOptions {
  /** Public ID of the skill (skl_…) or its workspace-unique slug */
  skillPublicId: string;
  /** Untrusted skill TOML, normalized before persistence. */
  content: string;
  /** Author-supplied summary of what changed (commit message) */
  changeSummary?: string;
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
  const {
    skillPublicId,
    content: untrustedContent,
    changeSummary,
    activate,
    orgId,
    workspaceId,
    userId,
  } = opts;

  // Validate and normalize before touching the DB.
  const { content, referencesPayload } =
    canonicalizeSkillArtifact(untrustedContent);

  return withTenantDb(async (tx) => {
    // 1. Resolve skill internal UUID from publicId or slug within this tenant
    //    scope (same dual resolution as skill.enable).
    const [skillRow] = await tx
      .select({ id: schema.skills.id, publicId: schema.skills.publicId })
      .from(schema.skills)
      .where(
        and(
          or(
            eq(schema.skills.publicId, skillPublicId),
            eq(schema.skills.slug, skillPublicId),
          ),
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

    // 2b. Load the prior latest version — it is the new row's parent and the
    //     row whose is_latest flag must be cleared. Its references_payload is
    //     selected so the carry-forward described in the header comment can be
    //     restored without another query; it is not merged today.
    const [priorLatest] = await tx
      .select({
        id: schema.skillVersions.id,
        referencesPayload: schema.skillVersions.referencesPayload,
      })
      .from(schema.skillVersions)
      .where(
        and(
          eq(schema.skillVersions.skillId, skillRow.id),
          eq(schema.skillVersions.isLatest, true),
        ),
      )
      .limit(1);

    // 3. Clear is_latest on the existing latest version (if any).
    //    The partial unique index (WHERE is_latest = true) enforces uniqueness,
    //    so we must clear first within the transaction before inserting.
    if (priorLatest) {
      await tx
        .update(schema.skillVersions)
        .set({ isLatest: false })
        .where(eq(schema.skillVersions.id, priorLatest.id));
    }

    // 4. Insert the new immutable version row.
    const [newVersion] = await tx
      .insert(schema.skillVersions)
      .values({
        orgId,
        workspaceId,
        skillId: skillRow.id,
        body: content,
        versionNumber: nextVersion,
        isLatest: true,
        parentVersionId: priorLatest?.id ?? null,
        publishedAt: new Date(),
        referencesPayload,
        changeSummary: changeSummary ?? null,
        checksum: skillBodyChecksum(content),
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
        skillPublicId: skillRow.publicId,
        skillId: skillRow.id,
        versionPublicId: newVersion.publicId,
        versionNumber: newVersion.versionNumber,
        parentVersionId: priorLatest?.id ?? null,
        activate,
        orgId,
        workspaceId,
      },
      "createNewSkillVersion: version created",
    );

    return {
      versionId: newVersion.publicId,
      versionNumber: newVersion.versionNumber,
      skillId: skillRow.publicId,
      activated: activate,
    };
  });
}

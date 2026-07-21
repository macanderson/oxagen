import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillCreate } from "@oxagen/oxagen/contracts/skill.create";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { skillBodyChecksum } from "./skill-checksum";
import { canonicalizeSkillArtifact } from "./skill-artifact";

export const skillCreateHandler: CapabilityHandler<typeof skillCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[skill.create] workspaceId is required (scoped capability)",
    );
  }

  const { content, activate } = input;
  const canonical = canonicalizeSkillArtifact(content);
  const { name: slug, description } = canonical.artifact;
  const name = canonical.artifact.metadata?.display_name ?? slug;
  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;

  // ── Idempotency check: if skill already exists for this slug, return it ────
  const existing = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.skills.id,
        publicId: schema.skills.publicId,
        slug: schema.skills.slug,
        activeVersionId: schema.skills.activeVersionId,
      })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.workspaceId, workspaceId),
          eq(schema.skills.slug, slug),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1),
  );

  if (existing[0]) {
    const existingSkill = existing[0];
    // Resolve active version number for the idempotent response
    let activeVersion = 1;
    if (existingSkill.activeVersionId) {
      const verRows = await withTenantDb((tx) =>
        tx
          .select({ versionNumber: schema.skillVersions.versionNumber })
          .from(schema.skillVersions)
          .where(eq(schema.skillVersions.id, existingSkill.activeVersionId!))
          .limit(1),
      );
      if (verRows[0]) activeVersion = verRows[0].versionNumber;
    }

    logger.info(
      { slug, publicId: existingSkill.publicId, workspaceId },
      "skill.create: idempotent — skill already exists",
    );

    return {
      publicId: existingSkill.publicId,
      slug: existingSkill.slug,
      activeVersion,
      created: false,
      artifact: canonical.artifact,
    };
  }

  // ── Create the skill + initial version in a transaction ─────────────────────
  let result: { publicId: string; slug: string; activeVersion: number };
  try {
    result = await withTenantDb(async (tx) => {
      const [skillRow] = await tx
        .insert(schema.skills)
        .values({
          orgId,
          workspaceId,
          name,
          slug,
          description: description || null,
          source: "tenant",
          enabled: true,
          createdByUserId: ctx.userId ?? undefined,
          updatedByUserId: ctx.userId ?? undefined,
        })
        .returning({
          id: schema.skills.id,
          publicId: schema.skills.publicId,
          slug: schema.skills.slug,
        });

      if (!skillRow) {
        throw new Error("[skill.create] Skill insert returned no row.");
      }

      // Insert version 1
      const [versionRow] = await tx
        .insert(schema.skillVersions)
        .values({
          orgId,
          workspaceId,
          skillId: skillRow.id,
          versionNumber: 1,
          isLatest: true,
          body: canonical.content,
          checksum: skillBodyChecksum(canonical.content),
          referencesPayload: canonical.referencesPayload,
          createdByUserId: ctx.userId ?? undefined,
          updatedByUserId: ctx.userId ?? undefined,
        })
        .returning({
          id: schema.skillVersions.id,
          versionNumber: schema.skillVersions.versionNumber,
        });

      if (!versionRow) {
        throw new Error("[skill.create] Skill version insert returned no row.");
      }

      // Pin the active version if requested
      if (activate) {
        await tx
          .update(schema.skills)
          .set({
            activeVersionId: versionRow.id,
            activatedByUserId: ctx.userId ?? undefined,
            activatedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(schema.skills.id, skillRow.id));
      }

      return {
        publicId: skillRow.publicId,
        slug: skillRow.slug,
        activeVersion: versionRow.versionNumber,
      };
    });
  } catch (err) {
    // Handle race condition: concurrent create with the same slug
    if (isUniqueViolation(err)) {
      const raceExisting = await withTenantDb((tx) =>
        tx
          .select({
            publicId: schema.skills.publicId,
            slug: schema.skills.slug,
            activeVersionId: schema.skills.activeVersionId,
          })
          .from(schema.skills)
          .where(
            and(
              eq(schema.skills.orgId, orgId),
              eq(schema.skills.workspaceId, workspaceId),
              eq(schema.skills.slug, slug),
              isNull(schema.skills.deletedAt),
            ),
          )
          .limit(1),
      );

      if (raceExisting[0]) {
        const raceSkill = raceExisting[0];
        let activeVersion = 1;
        if (raceSkill.activeVersionId) {
          const verRows = await withTenantDb((tx) =>
            tx
              .select({ versionNumber: schema.skillVersions.versionNumber })
              .from(schema.skillVersions)
              .where(eq(schema.skillVersions.id, raceSkill.activeVersionId!))
              .limit(1),
          );
          if (verRows[0]) activeVersion = verRows[0].versionNumber;
        }

        logger.info(
          { slug, publicId: raceSkill.publicId, workspaceId },
          "skill.create: idempotent — lost insert race",
        );
        return {
          publicId: raceSkill.publicId,
          slug: raceSkill.slug,
          activeVersion,
          created: false,
          artifact: canonical.artifact,
        };
      }
    }
    throw err;
  }

  logger.info(
    { slug, publicId: result.publicId, workspaceId, orgId },
    "skill.create: created",
  );

  return {
    publicId: result.publicId,
    slug: result.slug,
    activeVersion: result.activeVersion,
    created: true,
    artifact: canonical.artifact,
  };
};

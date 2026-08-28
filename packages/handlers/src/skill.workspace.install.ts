import type { CapabilityHandler } from "@oxagen/oxagen";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";
import { skillWorkspaceInstall } from "@oxagen/oxagen/contracts/skill.workspace.install";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createBuiltinSkillRegistry } from "@oxagen/skills";
import { logger } from "./logger";
import { skillBodyChecksum } from "./skill-checksum";
import {
  canonicalizeSkillArtifact,
  canonicalSkillMetadata,
} from "./skill-artifact";

// Builtin templates are resolved from EMBEDDED module data, never a runtime
// filesystem read: serverless bundlers drop packages/skills/skills data, so a
// `readdir` there returns ENOENT in prod.

/**
 * Derive a workspace-safe slug from a custom skill name. The name must already
 * be a valid kebab-case identifier per the skill artifact schema; we strip
 * any surrounding whitespace but otherwise trust the caller. The contract
 * validates min-length; the DB unique index guards duplicates.
 */
function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export const skillWorkspaceInstallHandler: CapabilityHandler<
  typeof skillWorkspaceInstall
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[skill.workspace.install] workspaceId is required (scoped capability)",
    );
  }

  const { slug: templateSlug, custom } = input;

  // ── Validate XOR: must provide exactly one of slug or custom ─────────────
  if (!templateSlug && !custom) {
    throw new Error(
      "[skill.workspace.install] Either `slug` (builtin template) or `custom` must be provided.",
    );
  }

  // ── Resolve the skill body + metadata from the appropriate source ─────────
  let targetSlug: string;
  let skillName: string;
  let skillBody: string;
  let skillDescription: string;
  let skillSource: string;
  let referencesPayload: unknown[];
  let installedFromSlug: string | null = null;

  if (templateSlug) {
    // Builtin path: load from the embedded builtin registry (bundle-safe).
    const registry = createBuiltinSkillRegistry();
    const builtin = await registry.get(templateSlug);
    if (!builtin) {
      throw new Error(
        `[skill.workspace.install] Builtin skill template "${templateSlug}" not found. ` +
          `Available slugs can be listed via agent.skill.list.`,
      );
    }
    targetSlug = builtin.slug;
    skillName = builtin.name;
    skillBody = canonicalizeSkillArtifact(
      serializeArtifactToml({
        schema_version: 1,
        kind: "skill",
        name: builtin.slug,
        description: builtin.description,
        instructions: builtin.body,
        references: builtin.references.map((reference) => reference.path),
        ...(canonicalSkillMetadata(builtin.metadata)
          ? { metadata: canonicalSkillMetadata(builtin.metadata) }
          : {}),
      }),
    ).content;
    skillDescription = builtin.description;
    skillSource = "builtin";
    referencesPayload = builtin.references.map((r) => ({
      path: r.path,
      body: r.body,
    }));
    installedFromSlug = templateSlug;
  } else {
    // Custom upload path.
    const canonical = canonicalizeSkillArtifact(custom!.content);
    targetSlug = slugFromName(canonical.artifact.name);
    skillName =
      canonical.artifact.metadata?.display_name ?? canonical.artifact.name;
    skillBody = canonical.content;
    skillDescription = canonical.artifact.description;
    skillSource = "tenant";
    referencesPayload = canonical.referencesPayload;
    installedFromSlug = null;
  }

  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;

  // Build the idempotent "already exists" response for a given slug, resolving
  // the active version number. Returns null if no live skill exists.
  const buildExistingResponse = async (): Promise<{
    publicId: string;
    slug: string;
    activeVersion: number;
    installed: false;
  } | null> => {
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
            eq(schema.skills.slug, targetSlug),
            isNull(schema.skills.deletedAt),
          ),
        )
        .limit(1),
    );

    const existingSkill = existing[0];
    if (!existingSkill) return null;

    let activeVersionNumber = 1;
    if (existingSkill.activeVersionId) {
      const verRows = await withTenantDb((tx) =>
        tx
          .select({ versionNumber: schema.skillVersions.versionNumber })
          .from(schema.skillVersions)
          .where(eq(schema.skillVersions.id, existingSkill.activeVersionId!))
          .limit(1),
      );
      if (verRows[0]) {
        activeVersionNumber = verRows[0].versionNumber;
      }
    }

    return {
      publicId: existingSkill.publicId,
      slug: existingSkill.slug,
      activeVersion: activeVersionNumber,
      installed: false,
    };
  };

  // ── Idempotency: return existing skill if one already exists for this slug ─
  const existingResponse = await buildExistingResponse();
  if (existingResponse) {
    logger.info(
      { slug: targetSlug, publicId: existingResponse.publicId, workspaceId },
      "skill.workspace.install: idempotent — skill already exists",
    );
    return existingResponse;
  }

  // ── Insert the skills row + first version in a single transaction ──────────
  // The existence check above and this insert run in separate sessions, so two
  // concurrent installs for the same (orgId, workspaceId, slug) can both pass
  // the check. The skills_workspace_slug_idx unique index makes the second
  // insert throw 23505; we catch it and return the idempotent response.
  let result: { publicId: string; slug: string; activeVersion: number };
  try {
    result = await withTenantDb(async (tx) => {
      // Insert the skill identity row (without activeVersionId — set after version insert).
      const [skillRow] = await tx
        .insert(schema.skills)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId!,
          name: skillName,
          slug: targetSlug,
          description: skillDescription || null,
          source: skillSource,
          enabled: true,
          installedFromSlug: installedFromSlug ?? undefined,
          createdByUserId: ctx.userId ?? undefined,
          updatedByUserId: ctx.userId ?? undefined,
        })
        .returning({
          id: schema.skills.id,
          publicId: schema.skills.publicId,
          slug: schema.skills.slug,
        });

      if (!skillRow) {
        throw new Error(
          "[skill.workspace.install] Skill insert returned no row.",
        );
      }

      // Insert version 1 (is_latest=true).
      const [versionRow] = await tx
        .insert(schema.skillVersions)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId!,
          skillId: skillRow.id,
          versionNumber: 1,
          isLatest: true,
          body: skillBody,
          checksum: skillBodyChecksum(skillBody),
          referencesPayload: referencesPayload,
          createdByUserId: ctx.userId ?? undefined,
          updatedByUserId: ctx.userId ?? undefined,
        })
        .returning({
          id: schema.skillVersions.id,
          versionNumber: schema.skillVersions.versionNumber,
        });

      if (!versionRow) {
        throw new Error(
          "[skill.workspace.install] Skill version insert returned no row.",
        );
      }

      // Back-fill activeVersionId now that we have the version id.
      await tx
        .update(schema.skills)
        .set({
          activeVersionId: versionRow.id,
          activatedByUserId: ctx.userId ?? undefined,
          activatedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.skills.id, skillRow.id));

      return {
        publicId: skillRow.publicId,
        slug: skillRow.slug,
        activeVersion: versionRow.versionNumber,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Concurrent install won the race: re-read and return the idempotent
      // response rather than surfacing a 23505 unique-violation 500.
      const raceResponse = await buildExistingResponse();
      if (raceResponse) {
        logger.info(
          { slug: targetSlug, publicId: raceResponse.publicId, workspaceId },
          "skill.workspace.install: idempotent — lost insert race",
        );
        return raceResponse;
      }
    }
    throw err;
  }

  logger.info(
    {
      slug: targetSlug,
      publicId: result.publicId,
      source: skillSource,
      installedFromSlug,
      workspaceId: ctx.workspaceId,
      orgId: ctx.orgId,
    },
    "skill.workspace.install: installed",
  );

  return {
    publicId: result.publicId,
    slug: result.slug,
    activeVersion: result.activeVersion,
    installed: true,
  };
};

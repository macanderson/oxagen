import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillWorkspaceInstall } from "@oxagen/oxagen/contracts/skill.workspace.install";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createSkillRegistry } from "@oxagen/skills";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

// Resolve the built-in skills directory relative to this file so the path
// stays correct regardless of working directory.
const __filename = fileURLToPath(import.meta.url);
const SKILLS_DIR = join(__filename, "../../../../skills/skills");

/**
 * Derive a workspace-safe slug from a custom skill name. The name must already
 * be a valid kebab-case identifier per the skill frontmatter schema; we strip
 * any surrounding whitespace but otherwise trust the caller. The contract
 * validates min-length; the DB unique index guards duplicates.
 */
function slugFromName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

export const skillWorkspaceInstallHandler: CapabilityHandler<typeof skillWorkspaceInstall> = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId) {
    throw new Error("[skill.workspace.install] workspaceId is required (scoped capability)");
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
    // Builtin path: load from the filesystem registry.
    const registry = createSkillRegistry({ fsRoot: SKILLS_DIR });
    const builtin = await registry.get(templateSlug);
    if (!builtin) {
      throw new Error(
        `[skill.workspace.install] Builtin skill template "${templateSlug}" not found. ` +
          `Available slugs can be listed via agent.skill.list.`,
      );
    }
    targetSlug = builtin.slug;
    skillName = builtin.name;
    skillBody = builtin.body;
    skillDescription = builtin.description;
    skillSource = "builtin";
    referencesPayload = builtin.references.map((r) => ({ path: r.path, body: r.body }));
    installedFromSlug = templateSlug;
  } else {
    // Custom upload path.
    targetSlug = slugFromName(custom!.name);
    skillName = custom!.name;
    skillBody = custom!.body;
    skillDescription = "";
    skillSource = "tenant";
    referencesPayload = (custom!.references ?? []).map((path) => ({ path, body: "" }));
    installedFromSlug = null;
  }

  // ── Idempotency: return existing skill if one already exists for this slug ─
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
          eq(schema.skills.orgId, ctx.orgId),
          eq(schema.skills.workspaceId, ctx.workspaceId!),
          eq(schema.skills.slug, targetSlug),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1),
  );

  if (existing[0]) {
    // Resolve active version number for the response.
    const existingSkill = existing[0];
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

    logger.info(
      { slug: targetSlug, publicId: existingSkill.publicId, workspaceId: ctx.workspaceId },
      "skill.workspace.install: idempotent — skill already exists",
    );

    return {
      publicId: existingSkill.publicId,
      slug: existingSkill.slug,
      activeVersion: activeVersionNumber,
      installed: false,
    };
  }

  // ── Insert the skills row + first version in a single transaction ──────────
  const result = await withTenantDb(async (tx) => {
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
      throw new Error("[skill.workspace.install] Skill insert returned no row.");
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
        referencesPayload: referencesPayload,
        createdByUserId: ctx.userId ?? undefined,
        updatedByUserId: ctx.userId ?? undefined,
      })
      .returning({ id: schema.skillVersions.id, versionNumber: schema.skillVersions.versionNumber });

    if (!versionRow) {
      throw new Error("[skill.workspace.install] Skill version insert returned no row.");
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

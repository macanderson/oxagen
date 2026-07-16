import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillExport } from "@oxagen/oxagen/contracts/skill.export";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, or } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Serialises a skill version back to `.skill.md` format.
 *
 * Only `name` and `description` are required frontmatter fields per
 * packages/skills/src/types.ts (skillFrontmatterSchema). We emit them in
 * a minimal but valid YAML block so the content round-trips through parseSkill.
 * Values are single-quoted to handle special characters without a yaml dep.
 */
function buildSkillMd(opts: {
  slug: string;
  description: string;
  body: string;
}): string {
  // Single-quote escaping: replace ' with '' (YAML single-quoted scalar rule).
  const yamlEscape = (s: string) => s.replace(/'/g, "''");
  const yamlBlock =
    `name: '${yamlEscape(opts.slug)}'\n` +
    `description: '${yamlEscape(opts.description)}'`;
  return `---\n${yamlBlock}\n---\n\n${opts.body.trimEnd()}\n`;
}

export const skillExportHandler: CapabilityHandler<typeof skillExport> = async (
  input,
  ctx,
) => {
  const { skillId, versionNumber } = input;

  // 1. Resolve the skill row by publicId or slug (confirms ownership + not deleted).
  const [skill] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.skills.id,
        slug: schema.skills.slug,
        name: schema.skills.name,
        description: schema.skills.description,
        activeVersionId: schema.skills.activeVersionId,
      })
      .from(schema.skills)
      .where(
        and(
          or(
            eq(schema.skills.publicId, skillId),
            eq(schema.skills.slug, skillId),
          ),
          eq(schema.skills.workspaceId, ctx.workspaceId),
          isNull(schema.skills.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!skill) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  // 2. Resolve the target version.
  let versionRow: { versionNumber: number; body: string } | undefined;

  if (versionNumber !== undefined) {
    // Caller requested a specific version.
    const [row] = await withTenantDb((tx) =>
      tx
        .select({
          versionNumber: schema.skillVersions.versionNumber,
          body: schema.skillVersions.body,
        })
        .from(schema.skillVersions)
        .where(
          and(
            eq(schema.skillVersions.skillId, skill.id),
            eq(schema.skillVersions.versionNumber, versionNumber),
          ),
        )
        .limit(1),
    );
    versionRow = row;
  } else if (skill.activeVersionId) {
    // Fall back to the explicitly pinned active version.
    const [row] = await withTenantDb((tx) =>
      tx
        .select({
          versionNumber: schema.skillVersions.versionNumber,
          body: schema.skillVersions.body,
        })
        .from(schema.skillVersions)
        .where(eq(schema.skillVersions.id, skill.activeVersionId!))
        .limit(1),
    );
    versionRow = row;
  } else {
    // Last resort: the latest version.
    const [row] = await withTenantDb((tx) =>
      tx
        .select({
          versionNumber: schema.skillVersions.versionNumber,
          body: schema.skillVersions.body,
        })
        .from(schema.skillVersions)
        .where(
          and(
            eq(schema.skillVersions.skillId, skill.id),
            eq(schema.skillVersions.isLatest, true),
          ),
        )
        .limit(1),
    );
    versionRow = row;
  }

  if (!versionRow) {
    throw new Error(
      versionNumber !== undefined
        ? `Version ${versionNumber} not found for skill ${skillId}`
        : `No version found for skill ${skillId}`,
    );
  }

  const content = buildSkillMd({
    slug: skill.slug,
    description: skill.description ?? "",
    body: versionRow.body,
  });

  const filename = `${skill.slug}.skill.md`;

  logger.info(
    {
      workspaceId: ctx.workspaceId,
      skillId,
      versionNumber: versionRow.versionNumber,
      surface: ctx.surface,
    },
    "skill.export: exported skill version",
  );

  return {
    filename,
    content,
    versionNumber: versionRow.versionNumber,
  };
};

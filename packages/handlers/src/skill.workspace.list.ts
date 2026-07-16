import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillWorkspaceList } from "@oxagen/oxagen/contracts/skill.workspace.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const skillWorkspaceListHandler: CapabilityHandler<
  typeof skillWorkspaceList
> = async (_input, ctx) => {
  // LEFT JOIN skill_versions on the pinned active version so the list can show
  // the active version number without an N+1 per-row lookup. The join is null
  // when a skill has no pinned active version yet → activeVersion is null.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.skills.publicId,
        slug: schema.skills.slug,
        name: schema.skills.name,
        description: schema.skills.description,
        source: schema.skills.source,
        installedFromSlug: schema.skills.installedFromSlug,
        enabled: schema.skills.enabled,
        updatedAt: schema.skills.updatedAt,
        activeVersionNumber: schema.skillVersions.versionNumber,
      })
      .from(schema.skills)
      .leftJoin(
        schema.skillVersions,
        eq(schema.skillVersions.id, schema.skills.activeVersionId),
      )
      .where(
        and(
          eq(schema.skills.workspaceId, ctx.workspaceId),
          isNull(schema.skills.deletedAt),
        ),
      )
      .orderBy(schema.skills.name),
  );

  logger.info(
    { workspaceId: ctx.workspaceId, count: rows.length, surface: ctx.surface },
    "skill.workspace.list: returned skills",
  );

  return {
    skills: rows.map((r) => ({
      id: r.publicId,
      slug: r.slug,
      name: r.name,
      description: r.description ?? "",
      source: r.source,
      installedFromSlug: r.installedFromSlug ?? null,
      enabled: r.enabled,
      activeVersion:
        r.activeVersionNumber != null ? `v${r.activeVersionNumber}` : null,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    })),
  };
};

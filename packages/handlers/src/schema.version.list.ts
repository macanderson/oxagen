import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaVersionList } from "@oxagen/oxagen/contracts/schema.version.list";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, desc, sql } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaVersionListHandler: CapabilityHandler<
  typeof schemaVersionList
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;

  const { versions, total } = await withTenantDb(async (tx) => {
    const [totalRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(db.schemaVersions)
      .where(eq(db.schemaVersions.registryId, registry.id));

    const rows = await tx
      .select()
      .from(db.schemaVersions)
      .where(eq(db.schemaVersions.registryId, registry.id))
      .orderBy(desc(db.schemaVersions.versionNumber))
      .limit(limit)
      .offset(offset);

    return { versions: rows, total: totalRow?.n ?? 0 };
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, count: versions.length },
    "schema.version.list: fetched versions",
  );

  return {
    versions: versions.map((v) => ({
      versionId: v.publicId,
      versionNumber: v.versionNumber,
      status: v.status as "draft" | "published",
      label: v.label,
      changeSummary: v.changeSummary,
      publishedAt: v.publishedAt?.toISOString() ?? null,
      isPinned: v.id === registry.pinnedVersionId,
    })),
    total,
  };
};

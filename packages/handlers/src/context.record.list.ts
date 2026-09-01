import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordList } from "@oxagen/oxagen/contracts/context.record.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, count, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const contextRecordListHandler: CapabilityHandler<
  typeof contextRecordList
> = async (input, ctx) => {
  const filters = and(
    eq(schema.contextRecords.workspaceId, ctx.workspaceId),
    isNull(schema.contextRecords.deletedAt),
    ...(input.status ? [eq(schema.contextRecords.status, input.status)] : []),
  );

  const [countRow] = await withTenantDb((tx) =>
    tx.select({ total: count() }).from(schema.contextRecords).where(filters),
  );
  const total = countRow?.total ?? 0;

  // LEFT JOIN the pinned active version for its number and checksum (same
  // shape as skill.workspace.list); null when no version is pinned.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.contextRecords.publicId,
        slug: schema.contextRecords.slug,
        title: schema.contextRecords.title,
        status: schema.contextRecords.status,
        updatedAt: schema.contextRecords.updatedAt,
        versionNumber: schema.contextRecordVersions.versionNumber,
        checksum: schema.contextRecordVersions.checksum,
      })
      .from(schema.contextRecords)
      .leftJoin(
        schema.contextRecordVersions,
        eq(
          schema.contextRecordVersions.id,
          schema.contextRecords.activeVersionId,
        ),
      )
      .where(filters)
      .orderBy(schema.contextRecords.slug)
      .limit(input.limit ?? 50)
      .offset(input.offset ?? 0),
  );

  logger.info(
    {
      workspaceId: ctx.workspaceId,
      count: rows.length,
      total,
      status: input.status ?? null,
      surface: ctx.surface,
    },
    "context.record.list: returned records",
  );

  return {
    records: rows.map((r) => ({
      id: r.publicId,
      recordId: r.slug,
      title: r.title,
      status: r.status,
      version: r.versionNumber ?? null,
      checksum: r.checksum ?? null,
      updatedAt: r.updatedAt.toISOString(),
    })),
    total,
  };
};

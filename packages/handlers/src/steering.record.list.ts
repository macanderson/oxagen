import type { CapabilityHandler } from "@oxagen/oxagen";
import { steeringRecordList } from "@oxagen/oxagen/contracts/steering.record.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, count, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const steeringRecordListHandler: CapabilityHandler<
  typeof steeringRecordList
> = async (input, ctx) => {
  const filters = and(
    eq(schema.steeringRecords.workspaceId, ctx.workspaceId),
    isNull(schema.steeringRecords.deletedAt),
    ...(input.status ? [eq(schema.steeringRecords.status, input.status)] : []),
  );

  const [countRow] = await withTenantDb((tx) =>
    tx.select({ total: count() }).from(schema.steeringRecords).where(filters),
  );
  const total = countRow?.total ?? 0;

  // LEFT JOIN the pinned active version for its number and checksum (same
  // shape as skill.workspace.list); null when no version is pinned.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.steeringRecords.publicId,
        slug: schema.steeringRecords.slug,
        title: schema.steeringRecords.title,
        status: schema.steeringRecords.status,
        updatedAt: schema.steeringRecords.updatedAt,
        versionNumber: schema.steeringRecordVersions.versionNumber,
        checksum: schema.steeringRecordVersions.checksum,
      })
      .from(schema.steeringRecords)
      .leftJoin(
        schema.steeringRecordVersions,
        eq(
          schema.steeringRecordVersions.id,
          schema.steeringRecords.activeVersionId,
        ),
      )
      .where(filters)
      .orderBy(schema.steeringRecords.slug)
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
    "steering.record.list: returned records",
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

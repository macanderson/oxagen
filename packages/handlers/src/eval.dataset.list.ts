import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalDatasetList } from "@oxagen/oxagen/contracts/eval.dataset.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull } from "drizzle-orm";

export const evalDatasetListHandler: CapabilityHandler<
  typeof evalDatasetList
> = async (_input, ctx) => {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.evalDatasets.publicId,
        name: schema.evalDatasets.name,
        slug: schema.evalDatasets.slug,
        description: schema.evalDatasets.description,
        source: schema.evalDatasets.source,
        itemCount: schema.evalDatasets.itemCount,
        createdAt: schema.evalDatasets.createdAt,
      })
      .from(schema.evalDatasets)
      .where(
        and(
          eq(schema.evalDatasets.workspaceId, ctx.workspaceId),
          isNull(schema.evalDatasets.deletedAt),
        ),
      )
      .orderBy(desc(schema.evalDatasets.createdAt)),
  );

  return {
    datasets: rows.map((r) => ({
      datasetId: r.publicId,
      name: r.name,
      slug: r.slug,
      description: r.description,
      source: r.source as "manual" | "traces",
      itemCount: r.itemCount,
      createdAt: r.createdAt.toISOString(),
    })),
  };
};

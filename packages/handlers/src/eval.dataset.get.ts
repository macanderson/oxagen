import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalDatasetGet } from "@oxagen/oxagen/contracts/eval.dataset.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, gt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

export const evalDatasetGetHandler: CapabilityHandler<
  typeof evalDatasetGet
> = async (input, ctx) => {
  return withTenantDb(async (tx) => {
    const [dataset] = await tx
      .select({
        publicId: schema.evalDatasets.publicId,
        name: schema.evalDatasets.name,
        slug: schema.evalDatasets.slug,
        description: schema.evalDatasets.description,
        source: schema.evalDatasets.source,
        itemCount: schema.evalDatasets.itemCount,
        createdAt: schema.evalDatasets.createdAt,
        id: schema.evalDatasets.id,
      })
      .from(schema.evalDatasets)
      .where(eq(schema.evalDatasets.publicId, input.datasetPublicId))
      .limit(1);
    if (!dataset) {
      throw new HTTPException(404, {
        message: `eval dataset ${input.datasetPublicId} not found`,
      });
    }

    // Keyset pagination over the time-ordered uuidv7 id. The opaque cursor is the
    // previous page's last item public id; resolve it to its id to seek past it.
    let afterId: string | null = null;
    if (input.cursor) {
      const [cursorRow] = await tx
        .select({ id: schema.evalDatasetItems.id })
        .from(schema.evalDatasetItems)
        .where(
          and(
            eq(schema.evalDatasetItems.datasetId, dataset.id),
            eq(schema.evalDatasetItems.publicId, input.cursor),
          ),
        )
        .limit(1);
      afterId = cursorRow?.id ?? null;
    }

    const rows = await tx
      .select({
        publicId: schema.evalDatasetItems.publicId,
        input: schema.evalDatasetItems.input,
        expectedOutput: schema.evalDatasetItems.expectedOutput,
        metadata: schema.evalDatasetItems.metadata,
      })
      .from(schema.evalDatasetItems)
      .where(
        and(
          eq(schema.evalDatasetItems.datasetId, dataset.id),
          afterId ? gt(schema.evalDatasetItems.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(schema.evalDatasetItems.id))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;

    return {
      dataset: {
        datasetId: dataset.publicId,
        name: dataset.name,
        slug: dataset.slug,
        description: dataset.description,
        source: dataset.source as "manual" | "traces",
        itemCount: dataset.itemCount,
        createdAt: dataset.createdAt.toISOString(),
      },
      items: page.map((r) => ({
        itemId: r.publicId,
        input: r.input,
        expectedOutput: r.expectedOutput,
        metadata: r.metadata as Record<string, unknown>,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.publicId : null,
    };
  });
};

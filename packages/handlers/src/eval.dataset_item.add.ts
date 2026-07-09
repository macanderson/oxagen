import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalDatasetItemAdd } from "@oxagen/oxagen/contracts/eval.dataset_item.add";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
import { resolveDataset } from "./_eval";
import { logger } from "./logger";

export const evalDatasetItemAddHandler: CapabilityHandler<
  typeof evalDatasetItemAdd
> = async (input, ctx) => {
  return withTenantDb(async (tx) => {
    const dataset = await resolveDataset(tx, input.datasetPublicId);

    // Single batch insert (never a per-item loop — that would be an N+1 write).
    await tx.insert(schema.evalDatasetItems).values(
      input.items.map((item) => ({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        datasetId: dataset.id,
        input: item.input,
        expectedOutput: item.expectedOutput ?? null,
        metadata: item.metadata,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })),
    );

    // Keep the denormalized count in sync so list/get avoid a COUNT(*) per row.
    const [updated] = await tx
      .update(schema.evalDatasets)
      .set({
        itemCount: sql`${schema.evalDatasets.itemCount} + ${input.items.length}`,
        updatedAt: new Date(),
        updatedByUserId: ctx.userId,
      })
      .where(eq(schema.evalDatasets.id, dataset.id))
      .returning({ itemCount: schema.evalDatasets.itemCount });

    logger.info(
      { datasetId: dataset.publicId, added: input.items.length },
      "add_dataset_item",
    );

    return {
      datasetId: dataset.publicId,
      added: input.items.length,
      itemCount: updated?.itemCount ?? dataset.itemCount + input.items.length,
    };
  });
};

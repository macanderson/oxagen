import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalDatasetCreate } from "@oxagen/oxagen/contracts/eval.dataset.create";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { HTTPException } from "hono/http-exception";
import { slugify } from "./lib/asset-filename";
import { logger } from "./logger";

export const evalDatasetCreateHandler: CapabilityHandler<
  typeof evalDatasetCreate
> = async (input, ctx) => {
  const slug = input.slug ?? (slugify(input.name).slice(0, 60) || "dataset");
  try {
    return await withTenantDb(async (tx) => {
      const [row] = await tx
        .insert(schema.evalDatasets)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          name: input.name,
          slug,
          description: input.description ?? null,
          source: "manual",
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({
          id: schema.evalDatasets.id,
          publicId: schema.evalDatasets.publicId,
          slug: schema.evalDatasets.slug,
        });
      if (!row) throw new Error("eval_datasets insert failed");
      logger.info(
        {
          datasetId: row.publicId,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        "create_dataset",
      );
      return {
        datasetId: row.publicId,
        publicId: row.publicId,
        slug: row.slug,
      };
    });
  } catch (err) {
    // A workspace-unique slug collision is a client error, not a 500.
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, {
        message: `an eval dataset with slug "${slug}" already exists in this workspace`,
      });
    }
    throw err;
  }
};

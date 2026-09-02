import { schema, type Tx } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

// Shared helpers for the eval.* handler family — one place that resolves a
// dataset by its public id under the active tenant scope, so the CRUD handlers
// never re-implement the lookup (and its 404) inline.

export interface ResolvedDataset {
  id: string;
  publicId: string;
  itemCount: number;
}

/** Resolve a live dataset by public id within an open transaction, or throw 404. */
export async function resolveDataset(
  tx: Tx,
  publicId: string,
): Promise<ResolvedDataset> {
  const [row] = await tx
    .select({
      id: schema.evalDatasets.id,
      publicId: schema.evalDatasets.publicId,
      itemCount: schema.evalDatasets.itemCount,
    })
    .from(schema.evalDatasets)
    .where(
      and(
        eq(schema.evalDatasets.publicId, publicId),
        isNull(schema.evalDatasets.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HTTPException(404, {
      message: `eval dataset ${publicId} not found`,
    });
  }
  return row;
}

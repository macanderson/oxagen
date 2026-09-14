/**
 * gau-settlements.ts — the settlement ledger's writers (ADR-055 §6,
 * apps/app/ARCHITECTURE.md §3.9 items 7 and 8c).
 *
 * Every function takes its executor first, the shape `tryInsertGrantLedger(tx,
 * …)` has: the recorder passes a `withTenantDb` transaction, the webhooks and
 * the close job a `withSystemDb` one. Nothing here opens a transaction of its
 * own, so the caller decides what commits together.
 */

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import type { GauTerms } from "./pricing";
import { GAU_REMAINING_SQL, type GauBucketRow } from "./gau-bucket";

export type GauSettlementRow = typeof schema.gauSettlements.$inferSelect;

/**
 * Claim the bucket's auto top-up episode and insert its `pending` settlement.
 *
 *   UPDATE billing.gau_buckets
 *      SET open_topup_settlement_id = :id, topup_seq = topup_seq + 1
 *    WHERE id = :bucket
 *      AND open_topup_settlement_id IS NULL
 *      AND included_gau + purchased_gau + carried_gau − used_gau <= 0
 *   RETURNING topup_seq
 *
 * Postgres re-evaluates the WHERE after the row lock is granted, so of N
 * concurrent recorders exactly one gets a row back and the rest get null; the
 * unique index on `(bucket_id, kind, seq)` backs that up. The settlement is
 * inserted in the same transaction, `pending`, with the terms' rate and
 * currency recorded at claim time (`quantity_gau = blocks × block_size_gau`).
 * The caller commits before its first provider call, so a crash after the
 * commit leaves a `pending` row a job can resume rather than a paid invoice
 * nothing remembers.
 *
 * Returns null when the episode was already open or the bucket is no longer
 * exhausted — no row is written in that case.
 */
export async function claimAutoTopup(
  tx: Tx,
  bucket: Pick<GauBucketRow, "id" | "orgId">,
  terms: GauTerms,
  blocks: number,
): Promise<GauSettlementRow | null> {
  const settlementId = crypto.randomUUID();
  const claimed = await tx
    .update(schema.gauBuckets)
    .set({
      openTopupSettlementId: settlementId,
      topupSeq: sql`${schema.gauBuckets.topupSeq} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.gauBuckets.id, bucket.id),
        isNull(schema.gauBuckets.openTopupSettlementId),
        lte(GAU_REMAINING_SQL, 0),
      ),
    )
    .returning({ topupSeq: schema.gauBuckets.topupSeq });
  const seq = claimed[0]?.topupSeq;
  if (seq === undefined) return null;

  const rows = await tx
    .insert(schema.gauSettlements)
    .values({
      id: settlementId,
      orgId: bucket.orgId,
      bucketId: bucket.id,
      kind: "auto_topup",
      seq,
      quantityGau: Math.max(1, Math.floor(blocks)) * terms.blockSizeGau,
      ratePerGauMicros: terms.ratePerGauMicros,
      currency: terms.currency,
      status: "pending",
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw new Error("billing: gau_settlements insert returned no row");
  }
  return row;
}

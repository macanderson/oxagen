// The GAU claims against a real Postgres (INV-30): concurrent recorders on
// one bucket leave exactly one interim_invoice row at the invoice threshold
// and exactly one auto_topup row at prepaid exhaustion, and the unique index
// on (bucket_id, kind, seq) refuses a duplicate. The fake executor the unit
// tests use interleaves writers one microtask at a time; this file is where
// real row locks and READ COMMITTED re-evaluation arbitrate. Runs wherever
// DATABASE_URL points at a migrated database — CI's `test` job migrates
// Postgres with Atlas before building and running the suites, and carries
// DATABASE_URL in turbo's globalEnv; a local run without one is skipped, not
// red. Every row it writes is removed in afterAll.
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq, inArray } from "drizzle-orm";
import {
  ensureCurrentBucket,
  remainingGau,
  uninvoicedGau,
  type GauBucketRow,
} from "./gau-bucket";
import { claimAutoTopup, claimInterimInvoice } from "./gau-settlements";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("GAU settlement claims against Postgres", () => {
  const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const orgIds: string[] = [];
  const TERMS = {
    currency: "usd",
    ratePerGauMicros: 5_000n,
    blockSizeGau: 5_000,
    includedGauPerMonth: 5_000,
  };
  const PERIOD = {
    start: new Date("2026-09-01T00:00:00.000Z"),
    end: new Date("2026-10-01T00:00:00.000Z"),
  };
  const INVOICE_GAU_MAX = 1_000;
  const RECORDERS = 20;

  async function newOrg(): Promise<string> {
    const id = crypto.randomUUID();
    const slug = `wl31-${tag}-${orgIds.length}`;
    await withSystemDb((tx) =>
      tx.insert(schema.organizations).values({
        id,
        name: `WL31 ${slug}`,
        slug,
        namespace: slug,
        planType: "free",
        status: "active",
      }),
    );
    orgIds.push(id);
    return id;
  }

  /** The recorder's debit: its own committed transaction. */
  function debit(orgId: string, usedDelta: number): Promise<GauBucketRow> {
    return withSystemDb((tx) =>
      ensureCurrentBucket(tx, orgId, {
        period: PERIOD,
        terms: TERMS,
        usedDelta,
        purchasedDelta: 0,
      }),
    );
  }

  function settlementsOf(orgId: string) {
    return withSystemDb((tx) =>
      tx
        .select()
        .from(schema.gauSettlements)
        .where(eq(schema.gauSettlements.orgId, orgId)),
    );
  }

  afterAll(async () => {
    if (orgIds.length > 0) {
      await withSystemDb(async (tx) => {
        await tx
          .delete(schema.gauSettlements)
          .where(inArray(schema.gauSettlements.orgId, orgIds));
        await tx
          .delete(schema.gauBuckets)
          .where(inArray(schema.gauBuckets.orgId, orgIds));
        await tx
          .delete(schema.organizations)
          .where(inArray(schema.organizations.id, orgIds));
      });
    }
    await closeDatabase();
  });

  it("20 concurrent recorders crossing invoice_gau_max leave exactly one interim_invoice row", async () => {
    const orgId = await newOrg();
    // One GAU short of the threshold: the first debit crosses it and every
    // later one sees uninvoiced >= the max until a claim lands.
    await debit(orgId, TERMS.includedGauPerMonth + INVOICE_GAU_MAX - 1);

    const claims = await Promise.all(
      Array.from({ length: RECORDERS }, async () => {
        const bucket = await debit(orgId, 1);
        if (uninvoicedGau(bucket) < INVOICE_GAU_MAX) return null;
        return withSystemDb((tx) =>
          claimInterimInvoice(tx, bucket, TERMS, INVOICE_GAU_MAX),
        );
      }),
    );

    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    const rows = await settlementsOf(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "interim_invoice",
      seq: 1,
      quantityGau: INVOICE_GAU_MAX,
      status: "pending",
    });
    const [bucket] = await withSystemDb((tx) =>
      tx
        .select()
        .from(schema.gauBuckets)
        .where(eq(schema.gauBuckets.orgId, orgId)),
    );
    expect(bucket).toMatchObject({
      usedGau: TERMS.includedGauPerMonth + INVOICE_GAU_MAX - 1 + RECORDERS,
      overageInvoicedGau: INVOICE_GAU_MAX,
      interimSeq: 1,
    });
    expect(uninvoicedGau(bucket!)).toBe(RECORDERS - 1);
  });

  it("20 concurrent recorders exhausting a prepaid bucket leave exactly one auto_topup row", async () => {
    const orgId = await newOrg();
    await debit(orgId, TERMS.includedGauPerMonth - 1);

    const claims = await Promise.all(
      Array.from({ length: RECORDERS }, async () => {
        const bucket = await debit(orgId, 1);
        if (remainingGau(bucket) > 0) return null;
        return withSystemDb((tx) => claimAutoTopup(tx, bucket, TERMS, 1));
      }),
    );

    expect(claims.filter((c) => c !== null)).toHaveLength(1);
    const rows = await settlementsOf(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "auto_topup",
      seq: 1,
      quantityGau: TERMS.blockSizeGau,
    });
  });

  it("the unique index refuses a second settlement with the same (bucket_id, kind, seq)", async () => {
    const orgId = await newOrg();
    const bucket = await debit(
      orgId,
      TERMS.includedGauPerMonth + INVOICE_GAU_MAX,
    );
    const first = await withSystemDb((tx) =>
      claimInterimInvoice(tx, bucket, TERMS, INVOICE_GAU_MAX),
    );
    expect(first).not.toBeNull();

    await expect(
      withSystemDb((tx) =>
        tx.insert(schema.gauSettlements).values({
          orgId,
          bucketId: bucket.id,
          kind: "interim_invoice",
          seq: first!.seq,
          quantityGau: INVOICE_GAU_MAX,
          ratePerGauMicros: TERMS.ratePerGauMicros,
          currency: TERMS.currency,
          status: "pending",
        }),
      ),
    ).rejects.toThrow();
    expect(await settlementsOf(orgId)).toHaveLength(1);
  });
});

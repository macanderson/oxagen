/**
 * Unit tests for gau-settlements.ts — claimAutoTopup (ADR-055 §6,
 * ARCHITECTURE.md §3.9 item 8c).
 *
 * Runs against the in-memory executor in test-utils/gau-fake-tx.ts, which
 * mirrors the re-checked claim UPDATE and records every statement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFakeGauStore,
  makeFakeGauTx,
  type FakeGauStore,
} from "./test-utils/gau-fake-tx";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

const { claimAutoTopup } = await import("./gau-settlements");

const ORG = "00000000-0000-0000-0000-00000000a0a1";
const FREE_TERMS = {
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
};

let store: FakeGauStore;

function seedBucket(overrides: Record<string, unknown>) {
  const row = {
    id: crypto.randomUUID(),
    orgId: ORG,
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    includedGau: 5_000,
    purchasedGau: 0,
    carriedGau: 0,
    usedGau: 5_000,
    overageInvoicedGau: 0,
    interimSeq: 0,
    topupSeq: 0,
    openTopupSettlementId: null,
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.buckets.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  store = makeFakeGauStore();
});

describe("claimAutoTopup", () => {
  it("claims the episode and inserts one pending auto_topup settlement for blocks × block_size at the terms' rate", async () => {
    const bucket = seedBucket({});
    const tx = makeFakeGauTx(store);

    const row = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);

    expect(row).toMatchObject({
      orgId: ORG,
      bucketId: bucket.id,
      kind: "auto_topup",
      seq: 1,
      quantityGau: 5_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      status: "pending",
    });
    expect(store.settlements).toHaveLength(1);
    expect(store.buckets[0]).toMatchObject({
      openTopupSettlementId: row!.id,
      topupSeq: 1,
    });
  });

  it("charges auto_topup_blocks blocks", async () => {
    const bucket = seedBucket({});
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      3,
    );
    expect(row?.quantityGau).toBe(15_000);
  });

  it("records the rate in force at claim time, so a later terms change does not reprice it", async () => {
    const bucket = seedBucket({});
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      { ...FREE_TERMS, ratePerGauMicros: 4_000n, blockSizeGau: 10_000 },
      1,
    );
    expect(row).toMatchObject({
      ratePerGauMicros: 4_000n,
      quantityGau: 10_000,
    });
  });

  it("claims nothing while an episode is already open, and writes no row", async () => {
    const bucket = seedBucket({
      openTopupSettlementId: crypto.randomUUID(),
      topupSeq: 1,
    });
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      1,
    );
    expect(row).toBeNull();
    expect(store.settlements).toHaveLength(0);
    expect(store.buckets[0]!.topupSeq).toBe(1);
  });

  it("claims nothing when the bucket is no longer exhausted (the re-checked WHERE)", async () => {
    const bucket = seedBucket({ usedGau: 4_999 });
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      1,
    );
    expect(row).toBeNull();
    expect(store.settlements).toHaveLength(0);
  });

  it("of 20 concurrent claims on one exhausted bucket exactly one gets a row", async () => {
    const bucket = seedBucket({});
    const tx = makeFakeGauTx(store);
    const rows = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimAutoTopup(tx, bucket, FREE_TERMS, 1),
      ),
    );
    expect(rows.filter((r) => r !== null)).toHaveLength(1);
    expect(store.settlements).toHaveLength(1);
    expect(store.buckets[0]!.topupSeq).toBe(1);
  });

  it("a second episode after the first is cleared gets seq 2", async () => {
    const bucket = seedBucket({});
    const tx = makeFakeGauTx(store);
    const first = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    store.buckets[0]!.openTopupSettlementId = null;
    const second = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
  });

  it("runs the claim and the insert on the executor it is passed, in that order, and opens no transaction", async () => {
    const bucket = seedBucket({});
    await claimAutoTopup(makeFakeGauTx(store), bucket, FREE_TERMS, 1);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(store.log.map((s) => `${s.op}:${s.table}`)).toEqual([
      "update:buckets",
      "insert:settlements",
    ]);
  });
});

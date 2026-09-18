import { beforeEach, describe, expect, it, vi } from "vitest";

// The store half of this file exercises real statements against an in-memory
// `cost.price_entries` (test-utils/price-book-fake-tx.ts), which evaluates the
// conditions the mocked `eq`/`and`/`or`/`isNull` build and interprets the raw
// upsert. `sql` stays real: the INSERT's casts and its ON CONFLICT arbiter are
// what the fake reads, and a mocked template would prove nothing about them.
const store = vi.hoisted(() => ({ tx: null as unknown }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { priceConditionMocks } = await import(
    "./test-utils/price-book-conditions"
  );
  return { ...real, ...priceConditionMocks };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(store.tx),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(store.tx),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  closeNegotiatedPriceEntry,
  BOUNDARY_MARGIN_MS,
  COLD_BOOK_EFFECTIVE_FROM,
  nextPriceBookBoundary,
  priceEntriesFromRateCards,
  resolvePriceEntry,
  setNegotiatedPriceEntry,
  syncPriceBook,
  usdPerMillionToMicros,
  usdPerUnitToMicrosPerMillion,
  type PriceEntry,
  type PriceEntrySeed,
} from "./price-book";
import {
  makeFakePriceStore,
  makeFakePriceTx,
  priceRow,
  type FakePriceStore,
} from "./test-utils/price-book-fake-tx";
import {
  IMAGE_RATE_CARD,
  PROVIDER_RATE_CARD,
  VIDEO_RATE_CARD,
} from "./pricing";

const ORG = "00000000-0000-4000-8000-000000000001";
const FROM = new Date("2026-09-01T00:00:00.000Z");

function entry(
  overrides: Partial<PriceEntry> & Pick<PriceEntry, "id" | "model">,
): PriceEntry {
  return {
    orgId: null,
    provider: "anthropic",
    modelAliases: [],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: FROM,
    effectiveTo: null,
    source: "list",
    ...overrides,
  };
}

describe("price conversions", () => {
  it("turns USD per million units into integer micros per million", () => {
    expect(usdPerMillionToMicros(3)).toBe(3_000_000n);
    expect(usdPerMillionToMicros(0.3)).toBe(300_000n);
    expect(usdPerMillionToMicros(18.75)).toBe(18_750_000n);
    expect(usdPerUnitToMicrosPerMillion(0.04)).toBe(40_000_000_000n);
    expect(() => usdPerMillionToMicros(-1)).toThrow(RangeError);
  });
});

describe("priceEntriesFromRateCards", () => {
  it("writes four token classes per token model and one row per media model", () => {
    const rows = priceEntriesFromRateCards(FROM);
    const tokenModels = Object.keys(PROVIDER_RATE_CARD).length;
    expect(rows).toHaveLength(
      tokenModels * 4 +
        Object.keys(IMAGE_RATE_CARD).length +
        Object.keys(VIDEO_RATE_CARD).length,
    );
    const sonnet = rows.filter((r) => r.model === "claude-sonnet-5");
    expect(sonnet.map((r) => [r.tokenClass, r.microsPerMillion])).toEqual([
      ["input_uncached", 3_000_000n],
      ["cache_read", 300_000n],
      ["cache_write_5m", 3_750_000n],
      ["output", 15_000_000n],
    ]);
    expect(
      sonnet.every((r) => r.effectiveFrom === FROM && r.unit === "token"),
    ).toBe(true);
    const image = rows.find((r) => r.model === "openai/gpt-image-1")!;
    expect(image).toMatchObject({
      tokenClass: "image",
      unit: "image",
      provider: "openai",
      microsPerMillion: 40_000_000_000n,
    });
  });

  it("is a pure function of the cards it is given", () => {
    const rows = priceEntriesFromRateCards(FROM, {
      tokens: {
        "m-1": {
          provider: "openai",
          inputPer1M: 1,
          outputPer1M: 2,
          cachedInputPer1M: 0.5,
          cacheWritePer1M: 1,
        },
      },
      images: {},
      videos: {},
    });
    expect(rows).toHaveLength(4);
  });
});

describe("resolvePriceEntry", () => {
  const list = entry({ id: "list-sonnet", model: "claude-sonnet-5" });
  const family = entry({ id: "list-sonnet-4", model: "claude-sonnet-4" });
  const negotiated = entry({
    id: "neg-sonnet",
    model: "claude-sonnet-5",
    orgId: ORG,
    source: "negotiated",
    microsPerMillion: 1_000_000n,
  });
  const at = new Date("2026-09-14T00:00:00.000Z");

  it("takes the organization's negotiated row before the list row", () => {
    expect(
      resolvePriceEntry([list, negotiated], {
        orgId: ORG,
        modelId: "claude-sonnet-5",
        tokenClass: "input_uncached",
        at,
      })?.id,
    ).toBe("neg-sonnet");
    expect(
      resolvePriceEntry([list, negotiated], {
        orgId: "another-org",
        modelId: "claude-sonnet-5",
        tokenClass: "input_uncached",
        at,
      })?.id,
    ).toBe("list-sonnet");
  });

  it("matches the longest prefix, an alias, and the family behind a gateway prefix", () => {
    const book = [list, family];
    const q = (modelId: string) =>
      resolvePriceEntry(book, {
        orgId: ORG,
        modelId,
        tokenClass: "input_uncached",
        at,
      })?.id;
    expect(q("claude-sonnet-5-20260901")).toBe("list-sonnet");
    expect(q("claude-sonnet-4-6")).toBe("list-sonnet-4");
    expect(q("anthropic/claude-sonnet-5")).toBe("list-sonnet");
    expect(q("gpt-9")).toBe(undefined);
    const aliased = entry({
      id: "aliased",
      model: "gpt-9",
      modelAliases: ["openai/gpt-9-preview"],
    });
    expect(
      resolvePriceEntry([aliased], {
        orgId: ORG,
        modelId: "openai/gpt-9-preview-2026",
        tokenClass: "input_uncached",
        at,
      })?.id,
    ).toBe("aliased");
  });

  it("selects by the window the frame's instant falls in", () => {
    const old = entry({
      id: "old",
      model: "claude-sonnet-5",
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: FROM,
      microsPerMillion: 2_000_000n,
    });
    const q = (when: string) =>
      resolvePriceEntry([old, list], {
        orgId: ORG,
        modelId: "claude-sonnet-5",
        tokenClass: "input_uncached",
        at: new Date(when),
      })?.id;
    expect(q("2026-03-01T00:00:00.000Z")).toBe("old");
    expect(q("2026-09-01T00:00:00.000Z")).toBe("list-sonnet");
    expect(q("2025-12-31T23:59:59.000Z")).toBe(undefined);
    expect(
      resolvePriceEntry([list], {
        orgId: ORG,
        modelId: "claude-sonnet-5",
        tokenClass: "output",
        at,
      }),
    ).toBe(null);
  });
});

// ── The write path ───────────────────────────────────────────────────────────
//
// `setNegotiatedPriceEntry` / `closeNegotiatedPriceEntry` run against the
// in-memory `cost.price_entries` above. What they are proving is the
// effective-dating rule the whole table exists for: a correction is a new row,
// never an edit to a row a run has already been priced against.

// Every write below carries a write instant BEFORE T1, so a rate starting at
// T1 or T2 is a future start and not a backdating; a test that needs the
// instant elsewhere states its own `now` after the spread.
const SET = {
  orgId: ORG,
  provider: "anthropic",
  model: "claude-sonnet-5",
  tokenClass: "input_uncached",
  now: new Date("2026-09-05T00:00:00.000Z"),
} as const;

const T1 = new Date("2026-09-10T00:00:00.000Z");
const T2 = new Date("2026-10-01T00:00:00.000Z");

describe("the negotiated write path", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    store.tx = makeFakePriceTx(fake);
  });

  /** Every stored row as the resolver reads it. */
  const book = (): PriceEntry[] =>
    fake.rows.map((r) => ({
      id: r.id as string,
      orgId: r.orgId as string | null,
      provider: r.provider as string,
      model: r.model as string,
      modelAliases: r.modelAliases as string[],
      region: r.region as string | null,
      tokenClass: r.tokenClass as PriceEntry["tokenClass"],
      unit: r.unit as PriceEntry["unit"],
      currency: r.currency as string,
      microsPerMillion: r.microsPerMillion as bigint,
      effectiveFrom: r.effectiveFrom as Date,
      effectiveTo: r.effectiveTo as Date | null,
      source: r.source as PriceEntry["source"],
    }));

  const priceAt = (at: Date) =>
    resolvePriceEntry(book(), {
      orgId: ORG,
      modelId: "claude-sonnet-5",
      tokenClass: "input_uncached",
      at,
    });

  it("writes a negotiated row that wins over the list row for the same model and class", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));

    const written = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: usdPerMillionToMicros(2.4),
      effectiveFrom: T1,
    });

    // The table's own check is `(source = 'list') = (org_id IS NULL)`: a
    // negotiated row with a null org is refused outright, so the org id and
    // the source travel together or not at all.
    expect(written.entry).toMatchObject({
      orgId: ORG,
      source: "negotiated",
      unit: "token",
      currency: "USD",
      microsPerMillion: 2_400_000n,
    });
    expect(written.closed).toBeNull();
    expect(priceAt(T1)?.microsPerMillion).toBe(2_400_000n);
    // The list row is untouched — another organization still reads 3.00.
    expect(
      resolvePriceEntry(book(), {
        orgId: "00000000-0000-4000-8000-0000000000ff",
        modelId: "claude-sonnet-5",
        tokenClass: "input_uncached",
        at: T1,
      })?.microsPerMillion,
    ).toBe(3_000_000n);
  });

  // The write instant for the in-place cases: before T1, so the row being
  // corrected has not begun and no run has been priced against it.
  const BEFORE = new Date("2026-09-05T00:00:00.000Z");

  it("is idempotent on the row key, and a re-set at the same instant corrects in place before it ships", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
      now: BEFORE,
    });
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
      now: BEFORE,
    });
    expect(fake.rows).toHaveLength(1);

    // Same key, corrected before it shipped: the row is updated, not doubled.
    const again = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T1,
      now: BEFORE,
    });
    expect(fake.rows).toHaveLength(1);
    expect(again.entry.microsPerMillion).toBe(2_000_000n);
    expect(again.closed).toBeNull();
  });

  // Both the app and the CLI omit the alias list when the operator types no
  // aliases. Coercing that omission to `[]` made every price correction erase
  // the stored names, after which frames arriving under them stopped being
  // priced at all.
  it("leaves the stored aliases alone when a correction names none", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      modelAliases: ["anthropic/claude-sonnet-5"],
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
      now: BEFORE,
    });
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T1,
      now: BEFORE,
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.modelAliases).toEqual(["anthropic/claude-sonnet-5"]);
    expect(fake.rows[0]!.microsPerMillion).toBe(2_000_000n);
  });

  // A LATER correction inserts a successor and never reaches the conflict
  // clause, so it has to carry the names itself. Starting it with an empty
  // list dropped every stored alias from that instant on.
  it("carries the stored aliases into a later successor when a correction names none", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      modelAliases: ["anthropic/claude-sonnet-5"],
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T2,
    });
    const successor = fake.rows.find(
      (r) => (r.effectiveFrom as Date).getTime() === T2.getTime(),
    );
    expect(successor?.modelAliases).toEqual(["anthropic/claude-sonnet-5"]);
  });

  // There is no open row after a rate was ended, but the latest row in the
  // chain still carries the names. Re-establishing the rate without retyping
  // them started the new row with none.
  it("carries the aliases of an ended rate into its re-establishment", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      modelAliases: ["anthropic/claude-sonnet-5"],
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await closeNegotiatedPriceEntry({ ...SET, at: T2 });
    const T3 = new Date(T2.getTime() + 86_400_000);
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_200_000n,
      effectiveFrom: T3,
    });
    const reestablished = fake.rows.find(
      (r) => (r.effectiveFrom as Date).getTime() === T3.getTime(),
    );
    expect(reestablished?.modelAliases).toEqual(["anthropic/claude-sonnet-5"]);
  });

  // The inherited names take part in the overlap check. Resolving them only
  // at insert time let a rate re-established after a gap restore an alias
  // another live row had taken up meanwhile, so two live rows answered for
  // one resolver identity.
  it("refuses to re-establish a rate whose inherited alias another live row now holds", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      model: "foo",
      modelAliases: ["vendor/foo"],
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await closeNegotiatedPriceEntry({ ...SET, model: "foo", at: T2 });
    // During the gap, `vendor/foo` is legitimately priced on its own.
    const T3 = new Date(T2.getTime() + 86_400_000);
    await setNegotiatedPriceEntry({
      ...SET,
      model: "vendor/foo",
      microsPerMillion: 2_000_000n,
      effectiveFrom: T3,
    });
    // Re-establishing `foo` without retyping its aliases would inherit
    // `vendor/foo` and collide with that row.
    const T4 = new Date(T3.getTime() + 86_400_000);
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        model: "foo",
        microsPerMillion: 2_200_000n,
        effectiveFrom: T4,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
  });

  it("replaces the stored aliases when a correction names an empty list", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      modelAliases: ["anthropic/claude-sonnet-5"],
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
      now: BEFORE,
    });
    await setNegotiatedPriceEntry({
      ...SET,
      modelAliases: [],
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
      now: BEFORE,
    });
    expect(fake.rows[0]!.modelAliases).toEqual([]);
  });

  // Without the lock two writes for one key read the same open row before
  // either commits, each closes it and inserts its own open row, and a later
  // removal closes only the newest — leaving the older negotiated rate in
  // force instead of falling back to the list price.
  it("takes a per-key lock before it reads, so two corrections cannot interleave", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    const ops = fake.log.map((l) => l.op);
    expect(ops[0]).toBe("lock");
    expect(ops.indexOf("lock")).toBeLessThan(ops.indexOf("select"));
    expect(fake.log[0]?.sql).toContain("pg_advisory_xact_lock");
  });

  it("closes the prior row at the new instant instead of mutating its price", async () => {
    const first = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    const second = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T2,
    });

    expect(fake.rows).toHaveLength(2);
    expect(second.closed?.id).toBe(first.entry.id);

    // The shipped row is still readable, still at the price it charged, now
    // with a window that ends where the new one begins — which is the whole
    // point: a run priced in September keeps the entry it was priced with.
    const shipped = fake.rows.find((r) => r.id === first.entry.id)!;
    expect(shipped.microsPerMillion).toBe(2_400_000n);
    expect(shipped.effectiveTo).toEqual(T2);

    expect(priceAt(new Date("2026-09-20T00:00:00.000Z"))?.id).toBe(
      first.entry.id,
    );
    expect(priceAt(T2)?.id).toBe(second.entry.id);
  });

  it("refuses a backdated write under an open row", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T2,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 1_000_000n,
        effectiveFrom: T1,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "price_entry_superseded",
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 1_000_000n,
        effectiveFrom: T1,
      }),
    ).rejects.toThrow(/must not start earlier/);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.microsPerMillion).toBe(2_400_000n);
  });

  it("refuses to reopen a row it has already ended at that instant", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await closeNegotiatedPriceEntry({ ...SET, at: T2 });

    // The upsert clears effective_to, so re-setting the same instant would
    // silently un-end the rate over a window that has already been billed.
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_400_000n,
        effectiveFrom: T1,
      }),
    ).rejects.toThrow(/later effectiveFrom/);
    expect(fake.rows[0]!.effectiveTo).toEqual(T2);
  });

  it("ends a negotiated rate so the organization falls back to the list price", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });

    const { closed, cancelled } = await closeNegotiatedPriceEntry({
      ...SET,
      at: T2,
    });
    expect(closed?.effectiveTo).toEqual(T2);
    expect(cancelled).toEqual([]);
    // Closed, not deleted: the row and its price are still there.
    expect(fake.rows).toHaveLength(2);
    expect(
      priceAt(new Date("2026-09-20T00:00:00.000Z"))?.microsPerMillion,
    ).toBe(2_400_000n);
    expect(priceAt(T2)?.microsPerMillion).toBe(3_000_000n);
    expect(priceAt(T2)?.source).toBe("list");

    // Re-ending what is already ended is a no-op, so a retry is safe.
    expect(await closeNegotiatedPriceEntry({ ...SET, at: T2 })).toEqual({
      closed: null,
      cancelled: [],
    });
  });

  // A removal that overlaps a write is the same race as two writes: both read
  // the old state, then the setter inserts a new open row despite the
  // removal, or the remover closes only the old row and reports success while
  // the new negotiated rate stands. Same lock, same key, so they serialise.
  it("takes the write's per-key lock before it reads, so a removal cannot interleave with a write", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    const setLocks = fake.log.filter((l) => l.op === "lock").map((l) => l.sql);
    fake.log.length = 0;

    await closeNegotiatedPriceEntry({ ...SET, at: T2 });
    const ops = fake.log.map((l) => l.op);
    expect(ops[0]).toBe("lock");
    expect(ops.indexOf("lock")).toBeLessThan(ops.indexOf("select"));
    // The SAME locks the write takes, in the same order: the class first,
    // then the key. Not a second set the write never waits on.
    const closeLocks = fake.log.filter((l) => l.op === "lock").map((l) => l.sql);
    expect(closeLocks).toEqual(setLocks);
    expect(closeLocks[0]).toContain("price_entry_class:");
  });

  // After a future-dated correction the current row is already closed at that
  // future instant and the scheduled row is the only open one. Picking "the
  // open row" then selected the future row, refused it as ending before it
  // starts, and left the visible current rate impossible to end.
  it("ends the rate in effect at `at`, and cancels a correction scheduled after it that has not begun", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));
    const first = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    const scheduled = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T2,
    });
    const endAt = new Date("2026-09-20T00:00:00.000Z");
    // Ended at the write instant: a cutoff in the past is refused.
    const now = endAt;

    const result = await closeNegotiatedPriceEntry({ ...SET, at: endAt, now });

    // The row that was in effect at `at` is the one that ends there.
    expect(result.closed?.id).toBe(first.entry.id);
    expect(result.closed?.effectiveTo).toEqual(endAt);
    // The scheduled correction would have re-established the rate at T2, so
    // it does not survive the end. It never priced anything, so it is removed.
    expect(result.cancelled.map((e) => e.id)).toEqual([scheduled.entry.id]);
    expect(fake.rows.find((r) => r.id === scheduled.entry.id)).toBeUndefined();
    expect(fake.log.some((l) => l.op === "delete")).toBe(true);

    expect(priceAt(new Date("2026-09-15T00:00:00.000Z"))?.id).toBe(
      first.entry.id,
    );
    expect(priceAt(endAt)?.source).toBe("list");
    expect(priceAt(T2)?.source).toBe("list");
  });

  it("refuses to end a rate before a scheduled correction that has already begun (negative)", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T2,
    });
    // The correction at T2 is already in force by the write instant: ending
    // the rate at an earlier instant would reprice runs settled under it.
    const now = new Date("2026-10-15T00:00:00.000Z");
    await expect(
      closeNegotiatedPriceEntry({
        ...SET,
        at: new Date("2026-09-20T00:00:00.000Z"),
        now,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "price_entry_ends_before_it_starts",
    });
    // Nothing moved: the first row still ends where the correction starts,
    // and the correction is still open.
    expect(fake.rows).toHaveLength(2);
    expect(fake.rows.map((r) => r.effectiveTo)).toEqual([T2, null]);

    // Ending it at or after the correction's start is the answer the refusal
    // points at, and it works.
    const ended = await closeNegotiatedPriceEntry({ ...SET, at: now, now });
    expect(ended.closed?.effectiveFrom).toEqual(T2);
    expect(ended.cancelled).toEqual([]);
  });

  it("refuses to touch the list row", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));

    await expect(closeNegotiatedPriceEntry({ ...SET, at: T2 })).rejects.toThrow(
      /not an organization's to change/,
    );
    expect(fake.rows[0]!.effectiveTo).toBeNull();
    expect(fake.rows[0]!.source).toBe("list");
  });

  // The row key carries the provider string, but `resolvePriceEntry` never
  // receives or filters on a frame's provider: two providers' rows for one
  // model and class would both match every call and the newer would win
  // globally, applying one provider's commercial terms to traffic billed by
  // the other. So the second provider is refused until the first is ended.
  it("refuses a second provider for a model and class the organization has already negotiated (negative)", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      provider: "openrouter",
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });

    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "anthropic",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_provider_conflict",
    });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.provider).toBe("openrouter");

    // The locks are keyed without the provider, so the two writes above would
    // have waited on each other rather than both reading an empty key. Two
    // distinct locks per write: the class, then the key.
    const locks = fake.log.filter((l) => l.op === "lock").map((l) => l.sql);
    expect(new Set(locks).size).toBe(2);

    // Once the first provider's rate is ended, the other can be set: the
    // ended window and the new one never overlap.
    await closeNegotiatedPriceEntry({ ...SET, provider: "openrouter", at: T2 });
    const written = await setNegotiatedPriceEntry({
      ...SET,
      provider: "anthropic",
      microsPerMillion: 2_000_000n,
      effectiveFrom: T2,
    });
    expect(written.entry.provider).toBe("anthropic");
    expect(priceAt(T2)?.id).toBe(written.entry.id);
    expect(priceAt(new Date("2026-09-20T00:00:00.000Z"))?.provider).toBe(
      "openrouter",
    );
  });

  // A row whose window has begun has priced frames whose cost records name
  // it in priceEntryIds. Correcting it in place would change what a settled
  // run cost the next time its rollup is recomputed, under the same entry id.
  it("refuses to correct a row in place once its window has begun (negative)", async () => {
    // Written ahead of T1 (SET's own instant), then corrected after T1.
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    const now = new Date("2026-09-15T00:00:00.000Z");
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_000_000n,
        effectiveFrom: T1,
        now,
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_already_effective",
    });
    expect(fake.rows[0]!.microsPerMillion).toBe(2_400_000n);

    // The same terms again is a retry, and stays a no-op.
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_400_000n,
        effectiveFrom: T1,
        now,
      }),
    ).resolves.toMatchObject({ closed: null });
    expect(fake.rows).toHaveLength(1);

    // A row that has NOT begun is still corrected in place: nothing has been
    // priced against it.
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 1_000_000n,
      effectiveFrom: T2,
      now,
    });
    const corrected = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 1_500_000n,
      effectiveFrom: T2,
      now,
    });
    expect(corrected.entry.microsPerMillion).toBe(1_500_000n);
    expect(fake.rows).toHaveLength(2);
  });

  // The resolver treats a model and its aliases as one identity, so `foo`
  // with alias `vendor/foo` and a later `vendor/foo` would be one thing priced
  // twice, and a frame would take whichever spelling it reported.
  it("refuses a model whose names overlap a live negotiated row under another model (negative)", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      model: "foo",
      modelAliases: ["vendor/foo"],
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        model: "vendor/foo",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_alias_conflict",
    });
    // The reverse direction too: a new alias that names a live model.
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        model: "bar",
        modelAliases: ["foo"],
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
    expect(fake.rows).toHaveLength(1);

    // Writes serialise on every name they answer to, sorted, so the write for
    // `vendor/foo` waits on the lock the `foo` write took for its alias.
    fake.log.length = 0;
    await setNegotiatedPriceEntry({
      ...SET,
      model: "vendor/foo",
      tokenClass: "output",
      microsPerMillion: 12_000_000n,
      effectiveFrom: T1,
    });
    const locks = fake.log.filter((l) => l.op === "lock").map((l) => l.sql);
    // The class lock, then the one name this write answers to.
    expect(locks).toHaveLength(2);
    expect(locks[0]).toContain("price_entry_class:");
    expect(locks[1]).toContain("vendor/foo|output|");

    // Once the first rate is ended, the overlapping name is free.
    await closeNegotiatedPriceEntry({ ...SET, model: "foo", at: T2 });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        model: "vendor/foo",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).resolves.toMatchObject({ closed: null });
  });

  // With no row at the instant there is nothing to compare, so the shipped-
  // window guard above never fires — yet a first rate starting in the past
  // wins over the list price for every historical frame and a rollup retry
  // would change settled costs. Refused beyond the grace that covers the
  // instant a caller took just before its request.
  it("refuses a first negotiated rate that starts in the past, beyond the grace (negative)", async () => {
    const now = new Date("2026-09-18T12:00:00.000Z");
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_400_000n,
        effectiveFrom: T1,
        now,
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_starts_in_past",
    });
    expect(fake.rows).toHaveLength(0);

    // The instant the dialog took a moment before its request is "now".
    const justBefore = new Date(now.getTime() - 30_000);
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_400_000n,
        effectiveFrom: justBefore,
        now,
      }),
    ).resolves.toMatchObject({ closed: null });
    expect(fake.rows).toHaveLength(1);
  });

  it("leaves a different token class under another provider alone", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      provider: "openrouter",
      tokenClass: "output",
      microsPerMillion: 12_000_000n,
      effectiveFrom: T1,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "anthropic",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T1,
      }),
    ).resolves.toMatchObject({ closed: null });
    expect(fake.rows).toHaveLength(2);
  });

  it("refuses to end a rate at or before it starts once it is in force", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T2,
    });
    await expect(
      closeNegotiatedPriceEntry({
        ...SET,
        at: T2,
        now: new Date("2026-10-15T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/before it starts/);
  });

  // A cutoff in the past shortens a window that has already priced runs: on a
  // rollup retry every frame between `at` and now would resolve to the list
  // price while its cost record still cites the negotiated entry.
  it("refuses to end a rate in the past, over a window that has shipped (negative)", async () => {
    const first = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    const now = new Date("2026-09-20T00:00:00.000Z");
    await expect(
      closeNegotiatedPriceEntry({
        ...SET,
        at: new Date("2026-09-15T00:00:00.000Z"),
        now,
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_window_shipped",
    });
    expect(fake.rows[0]!.effectiveTo).toBeNull();
    // Ending it now, or later, is the answer the refusal points at.
    const ended = await closeNegotiatedPriceEntry({ ...SET, at: now, now });
    expect(ended.closed?.id).toBe(first.entry.id);
    expect(ended.closed?.effectiveTo).toEqual(now);
  });

  // The current row already ends at the correction's start, so ending the
  // rate AT that instant means list pricing from the transition on: the
  // unshipped correction is cancelled, exactly as one scheduled after `at`.
  it("cancels an unshipped correction when the rate is ended at its exact start", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));
    const first = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    const scheduled = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T2,
    });
    const result = await closeNegotiatedPriceEntry({
      ...SET,
      at: T2,
      now: new Date("2026-09-20T00:00:00.000Z"),
    });
    // Nothing was in effect at T2 to close: the first row already ended there.
    expect(result.closed).toBeNull();
    expect(result.cancelled.map((e) => e.id)).toEqual([scheduled.entry.id]);
    expect(fake.rows.map((r) => r.id)).toEqual([
      expect.any(String),
      first.entry.id,
    ]);
    expect(priceAt(new Date("2026-09-20T00:00:00.000Z"))?.id).toBe(
      first.entry.id,
    );
    expect(priceAt(T2)?.source).toBe("list");
  });
});

describe("syncPriceBook supersedes a row whose provider changed", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    store.tx = makeFakePriceTx(fake);
  });

  const openRows = () => fake.rows.filter((r) => r.effectiveTo === null);

  // A catalog that republishes a model under new names without moving its
  // rate used to take the `unchanged` path, because only price, currency and
  // unit were compared. The row then kept its first-inserted aliases forever:
  // a newly published identifier arrived unpriced, and a withdrawn one went on
  // matching. A rename is also NOT a repricing, so it must not open a new
  // effective-dated window.
  // Aliases decide which frames a row prices, and the rollup resolves a frame
  // with the row's names as stored at the frame's instant. Updated in place
  // on a months-old row, an added alias would retroactively price old frames
  // and a withdrawn one would leave priceable frames unpriced on the next
  // recomputation. So a rename is a successor window, like a repricing.
  it("writes a successor row when only the names moved, and closes the old one at the sync instant", async () => {
    fake.rows.push(
      priceRow({
        provider: "anthropic",
        microsPerMillion: 2_000_000n,
        modelAliases: ["anthropic/claude-sonnet-5"],
        effectiveFrom: FROM,
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          modelAliases: ["anthropic/claude-sonnet-5", "claude-sonnet-5-latest"],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 2_000_000n,
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });

    expect(result).toMatchObject({ renamed: 1, written: 0, unchanged: 0 });
    expect(fake.rows).toHaveLength(2);
    const [old, successor] = fake.rows;
    // The old row keeps the names it priced frames under, closed at T1.
    expect(old!.modelAliases).toEqual(["anthropic/claude-sonnet-5"]);
    expect(old!.effectiveTo).toEqual(T1);
    expect(successor!.modelAliases).toEqual([
      "anthropic/claude-sonnet-5",
      "claude-sonnet-5-latest",
    ]);
    expect(successor!.effectiveFrom).toEqual(T1);
    expect(successor!.effectiveTo).toBeNull();
    expect(successor!.microsPerMillion).toBe(2_000_000n);
  });

  // A same-instant re-run that changes a rate would rewrite a row frames
  // earlier in that window were priced with; the entry id on their cost
  // records would then cite different terms. Ahead of the instant nothing has
  // been priced, so the in-place correction stays.
  it("refuses to correct a list row in place once its instant has passed, and allows it ahead of time (negative)", async () => {
    fake.rows.push(
      priceRow({ effectiveFrom: T1, microsPerMillion: 3_000_000n }),
    );
    const seed = (micros: bigint, at: Date): PriceEntrySeed => ({
      provider: "anthropic",
      model: "claude-sonnet-5",
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: micros,
      effectiveFrom: at,
      effectiveTo: null,
    });
    await expect(
      syncPriceBook({
        effectiveFrom: T1,
        seeds: [seed(2_000_000n, T1)],
        now: new Date("2026-09-10T00:30:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_book_row_already_effective",
    });
    expect(fake.rows[0]!.microsPerMillion).toBe(3_000_000n);

    // Unchanged terms at the same instant are still a no-op.
    const same = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed(3_000_000n, T1)],
      now: new Date("2026-09-10T00:30:00.000Z"),
    });
    expect(same.unchanged).toBe(1);

    // A row scheduled ahead of the write instant corrects in place.
    fake.rows.length = 0;
    fake.rows.push(
      priceRow({ effectiveFrom: T2, microsPerMillion: 3_000_000n }),
    );
    // Not a cold book: the row exists. Only the price moves.
    const ahead = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [seed(2_000_000n, T2)],
      now: new Date("2026-09-20T00:00:00.000Z"),
    });
    expect(ahead.written).toBe(1);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.microsPerMillion).toBe(2_000_000n);
  });

  // The hourly job serialises its own executions, but the CLI's --apply runs
  // the same read-modify-write outside that guard; two syncs with different
  // instants would each close the same open rows and insert their own
  // successor, since the key includes effective_from.
  it("takes the list-book lock before it reads, so a CLI sync cannot interleave with the scheduled one", async () => {
    fake.rows.push(priceRow());
    await syncPriceBook({ effectiveFrom: T1, seeds: [] });
    const ops = fake.log.map((l) => l.op);
    expect(ops[0]).toBe("lock");
    expect(fake.log[0]?.sql).toContain("price_book:list");
    expect(ops.indexOf("lock")).toBeLessThan(ops.indexOf("select"));
  });

  // An operator scheduled a correction for one key beyond the next boundary.
  // Refusing the whole refresh over it rolled back every other model's update,
  // every hour, until the scheduled instant arrived.
  it("leaves a key with a scheduled correction alone and refreshes the rest", async () => {
    const SCHEDULED = new Date("2026-10-01T00:00:00.000Z");
    fake.rows.push(
      priceRow({
        model: "claude-sonnet-5",
        microsPerMillion: 2_500_000n,
        effectiveFrom: SCHEDULED,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      priceRow({
        model: "claude-haiku-5",
        microsPerMillion: 1_000_000n,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const seedFor = (model: string, micros: bigint): PriceEntrySeed => ({
      provider: "anthropic",
      model,
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: micros,
      effectiveFrom: T1,
      effectiveTo: null,
    });
    const result = await syncPriceBook({
      effectiveFrom: T1,
      now: new Date("2026-09-18T00:00:00.000Z"),
      seeds: [
        seedFor("claude-sonnet-5", 3_000_000n),
        seedFor("claude-haiku-5", 1_200_000n),
      ],
    });
    expect(result.deferred).toBe(1);
    expect(result.written).toBe(1);
    // The scheduled row is untouched...
    const scheduled = fake.rows.find(
      (r) => r.model === "claude-sonnet-5" && r.effectiveFrom === SCHEDULED,
    );
    expect(scheduled?.effectiveTo).toBeNull();
    expect(scheduled?.microsPerMillion).toBe(2_500_000n);
    // ...and the other key refreshed.
    const haiku = fake.rows.filter((r) => r.model === "claude-haiku-5");
    expect(haiku.some((r) => r.microsPerMillion === 1_200_000n)).toBe(true);
  });

  // A model whose vendor string changed is not a model the book has never
  // seen. Keying "seen" on the full row key, provider included, called it new,
  // backdated the new-provider row to the floor, and the supersession pass
  // then refused the old row starting at that same instant. Every hourly
  // refresh rolled back for as long as the book stayed cold.
  it("gives a provider rename the requested instant while the book is cold", async () => {
    fake.rows.push(
      priceRow({
        provider: "openrouter",
        microsPerMillion: 3_000_000n,
        effectiveFrom: COLD_BOOK_EFFECTIVE_FROM,
        createdAt: new Date("2026-09-17T00:00:00.000Z"),
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: T1,
      now: new Date("2026-09-18T00:00:00.000Z"),
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 3_000_000n,
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });
    expect(result.coldStart).toBe(true);
    expect(result.superseded).toBe(1);
    const renamed = fake.rows.find((r) => r.provider === "anthropic");
    expect(renamed?.effectiveFrom).toEqual(T1);
    const old = fake.rows.find((r) => r.provider === "openrouter");
    expect(old?.effectiveTo).toEqual(T1);
  });

  // A book whose rates never moved had no real-instant row, so it stayed cold
  // for ever, and a model a catalog added months later was backdated to the
  // floor: a rollup retry then priced frames from before any rate was known.
  it("stops backdating new models once the book is past its cold-start window", async () => {
    fake.rows.push(
      priceRow({
        model: "claude-sonnet-5",
        effectiveFrom: COLD_BOOK_EFFECTIVE_FROM,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const LATER = new Date("2026-09-18T16:00:00.000Z");
    const result = await syncPriceBook({
      effectiveFrom: LATER,
      now: new Date("2026-09-18T15:10:00.000Z"),
      seeds: [
        {
          provider: "anthropic",
          model: "claude-brand-new",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 1_000_000n,
          effectiveFrom: LATER,
          effectiveTo: null,
        },
      ],
    });
    expect(result.coldStart).toBe(false);
    const added = fake.rows.find((r) => r.model === "claude-brand-new");
    expect(added?.effectiveFrom).toEqual(LATER);
  });

  // A key whose only row is CLOSED was priced and then retired; it is not a
  // key the book has never seen. Backdating its return to the floor collided
  // with the original floor-dated row, and the upsert reset that row's
  // `effective_to` to null — erasing the retirement window and repricing
  // every frame inside it.
  it("does not reopen a retired row when its model returns while the book is still cold", async () => {
    const RETIRED_AT = new Date("2026-09-05T00:00:00.000Z");
    fake.rows.push(
      priceRow({
        provider: "anthropic",
        microsPerMillion: 3_000_000n,
        effectiveFrom: COLD_BOOK_EFFECTIVE_FROM,
        effectiveTo: RETIRED_AT,
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: T1,
      // Inside the cold-start window of the book's first row (created
      // 2026-09-01), so the book is still cold.
      now: new Date("2026-09-03T00:00:00.000Z"),
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 3_000_000n,
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });
    expect(result.coldStart).toBe(true);
    // The retired row keeps its window...
    const retired = fake.rows.find(
      (r) => (r.effectiveFrom as Date).getTime() === COLD_BOOK_EFFECTIVE_FROM.getTime(),
    );
    expect(retired?.effectiveTo).toEqual(RETIRED_AT);
    // ...and the return is a successor at the requested instant.
    expect(fake.rows).toHaveLength(2);
    expect(
      fake.rows.some(
        (r) =>
          (r.effectiveFrom as Date).getTime() === T1.getTime() &&
          r.effectiveTo === null,
      ),
    ).toBe(true);
  });

  // On a fresh installation the hourly job is the first writer, and a run
  // accepted before its first tick has frames earlier than that tick. Rows
  // effective from the tick could never price them, even on a retry.
  it("writes a cold book effective from before any frame, so runs before the first sync still price", async () => {
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 3_000_000n,
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });
    expect(result.coldStart).toBe(true);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.effectiveFrom).toEqual(COLD_BOOK_EFFECTIVE_FROM);
    // A frame from a week before the first sync resolves.
    const book: PriceEntry[] = fake.rows.map((r) => ({
      ...(r as unknown as PriceEntry),
    }));
    expect(
      resolvePriceEntry(book, {
        orgId: ORG,
        modelId: "claude-sonnet-5",
        tokenClass: "input_uncached",
        at: new Date("2026-09-03T00:00:00.000Z"),
      })?.microsPerMillion,
    ).toBe(3_000_000n);

    // A warm book takes the requested instant.
    const again = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 2_000_000n,
          effectiveFrom: T2,
          effectiveTo: null,
        },
      ],
    });
    // The book was still cold when that sync began (every row sat at the
    // floor), but the key was already priced, so the correction takes the
    // requested instant — and that real-instant row is what ends cold start.
    expect(again.coldStart).toBe(true);
    expect(
      fake.rows.find((r) => r.effectiveTo === null)!.effectiveFrom,
    ).toEqual(T2);
    const warm = await syncPriceBook({ effectiveFrom: T2, seeds: [] });
    expect(warm.coldStart).toBe(false);
  });

  // A first sync that ran with a catalog down seeds only the card's models.
  // If that alone ended cold start, the catalog's models would arrive at
  // recovery time and calls made before recovery would stay unpriced.
  it("stays cold after a partial first sync, so a model a recovered catalog adds is backdated too", async () => {
    const seed = (model: string): PriceEntrySeed => ({
      provider: "moonshot",
      model,
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: 2_000_000n,
      effectiveFrom: T2,
      effectiveTo: null,
    });
    // First tick: only the card answered.
    await syncPriceBook({ effectiveFrom: T1, seeds: [seed("card-model")] });
    // Next tick: the catalog is back and names a model the book never saw.
    const result = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [seed("card-model"), seed("catalog-model")],
    });
    expect(result.coldStart).toBe(true);
    expect(
      fake.rows.find((r) => r.model === "catalog-model")!.effectiveFrom,
    ).toEqual(COLD_BOOK_EFFECTIVE_FROM);
    expect(result.unchanged).toBe(1);
  });

  it("reports a row whose price and names both match as unchanged", async () => {
    fake.rows.push(
      priceRow({
        provider: "anthropic",
        microsPerMillion: 2_000_000n,
        modelAliases: ["b", "a"],
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          // Order is how a catalog happened to serialise them, not a change.
          modelAliases: ["a", "b"],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 2_000_000n,
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });
    expect(result).toMatchObject({ unchanged: 1, renamed: 0, written: 0 });
  });

  it("leaves exactly one open row per model and class when the vendor string changes", async () => {
    // The book already prices this model under one vendor name.
    fake.rows.push(
      priceRow({ provider: "openrouter", microsPerMillion: 3_000_000n }),
    );

    // A later sync prices the same model and class, but the source that won
    // it now names a different vendor. The row key includes `provider`, so
    // without the supersede pass this writes a second row and leaves the
    // first one open — and `bestMatch` would then pick between two live
    // prices by whichever sorted first.
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: usdPerMillionToMicros(2),
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });

    expect(result.written).toBe(1);
    expect(result.superseded).toBe(1);

    const open = openRows();
    expect(open).toHaveLength(1);
    expect(open[0]!.provider).toBe("anthropic");
    expect(open[0]!.microsPerMillion).toBe(usdPerMillionToMicros(2));

    // The old row is closed at the new row's instant, not deleted: a run
    // priced before T1 can still name the entry it was priced with.
    const closed = fake.rows.find((r) => r.provider === "openrouter")!;
    expect(closed.effectiveTo).toEqual(T1);
    expect(closed.microsPerMillion).toBe(3_000_000n);
  });

  // The CLI defaults `effectiveFrom` to the top of the hour, so a re-run
  // within the hour that finds a different vendor string writes a second row
  // starting at the same instant as the first, and the first cannot be
  // closed there. Two open rows with one start is a tie the resolver cannot
  // break, so the sync refuses and rolls back.
  it("refuses a provider change at the same instant as the open row it would supersede (negative)", async () => {
    fake.rows.push(priceRow({ provider: "openrouter", effectiveFrom: T1 }));
    await expect(
      syncPriceBook({
        effectiveFrom: T1,
        seeds: [
          {
            provider: "anthropic",
            model: "claude-sonnet-5",
            modelAliases: [],
            region: null,
            tokenClass: "input_uncached",
            unit: "token",
            currency: "USD",
            microsPerMillion: usdPerMillionToMicros(2),
            effectiveFrom: T1,
            effectiveTo: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_book_provider_changed_at_same_instant",
    });
  });

  it("leaves a row under a different model or class alone", async () => {
    fake.rows.push(priceRow({ provider: "openrouter", tokenClass: "output" }));

    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: usdPerMillionToMicros(2),
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });

    expect(result.superseded).toBe(0);
    expect(openRows()).toHaveLength(2);
  });
});

describe("syncPriceBook retires what a complete refresh no longer emits", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    store.tx = makeFakePriceTx(fake);
  });

  const seed = (over: Partial<PriceEntrySeed> = {}): PriceEntrySeed => ({
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: T1,
    effectiveTo: null,
    ...over,
  });

  // A model a vendor retired, or a class a catalog stopped publishing, is
  // absent from the seeds. Left open its last rate would price frames for
  // ever, and a class that should now read `estimated` would carry a figure.
  it("closes an open row the seeds no longer name, at the sync's instant", async () => {
    fake.rows.push(priceRow({ tokenClass: "input_uncached" }));
    fake.rows.push(
      priceRow({ tokenClass: "cache_read", microsPerMillion: 300_000n }),
    );
    const retiredModel = priceRow({
      model: "claude-sonnet-4",
      microsPerMillion: 2_000_000n,
    });
    fake.rows.push(retiredModel);

    const result = await syncPriceBook({
      effectiveFrom: T1,
      // The catalog still prices input, stopped publishing cache_read, and
      // withdrew claude-sonnet-4 altogether.
      seeds: [seed()],
      retireAbsent: true,
    });

    expect(result).toMatchObject({ unchanged: 1, retired: 2, written: 0 });
    const byKey = (model: string, tokenClass: string) =>
      fake.rows.find((r) => r.model === model && r.tokenClass === tokenClass)!;
    expect(byKey("claude-sonnet-5", "input_uncached").effectiveTo).toBeNull();
    // Closed, never deleted: a run priced before T1 still names the entry.
    expect(byKey("claude-sonnet-5", "cache_read").effectiveTo).toEqual(T1);
    expect(byKey("claude-sonnet-4", "input_uncached").effectiveTo).toEqual(T1);
    expect(fake.rows).toHaveLength(3);
  });

  // A same-hour re-run uses the same future boundary. A row an earlier run
  // scheduled there has priced nothing, and the complete snapshot now omits
  // it, so it must not take effect at the boundary. It cannot be closed at
  // its own start, so it is removed.
  it("cancels an omitted row scheduled at the still-future boundary", async () => {
    const BOUNDARY = new Date("2026-09-18T16:00:00.000Z");
    fake.rows.push(
      priceRow({ model: "claude-withdrawn", effectiveFrom: BOUNDARY }),
    );
    const result = await syncPriceBook({
      effectiveFrom: BOUNDARY,
      now: new Date("2026-09-18T15:30:00.000Z"),
      seeds: [seed()],
      retireAbsent: true,
    });
    expect(result.retired).toBeGreaterThanOrEqual(1);
    expect(fake.rows.some((r) => r.model === "claude-withdrawn")).toBe(false);
  });

  // A row absent because its catalog was down is not a price that ended. The
  // caller knows which happened and says so; without the flag nothing closes.
  it("retires nothing unless the caller vouched for the seeds as complete", async () => {
    fake.rows.push(priceRow({ model: "claude-sonnet-4" }));
    const result = await syncPriceBook({ effectiveFrom: T1, seeds: [seed()] });
    expect(result.retired).toBe(0);
    expect(
      fake.rows.find((r) => r.model === "claude-sonnet-4")!.effectiveTo,
    ).toBeNull();
  });

  it("never touches a negotiated row, and never closes a row that starts at or after the sync", async () => {
    fake.rows.push(
      priceRow({
        orgId: ORG,
        source: "negotiated",
        model: "claude-sonnet-4",
        microsPerMillion: 1_000_000n,
      }),
    );
    // A list row already scheduled to start after this sync: a later
    // correction this run must not close, since it cannot end before it starts.
    fake.rows.push(priceRow({ model: "gpt-9", effectiveFrom: T2 }));

    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed()],
      retireAbsent: true,
    });
    expect(result.retired).toBe(0);
    expect(fake.rows.filter((r) => r.effectiveTo === null)).toHaveLength(3);
  });

  it("does not count a row it already superseded under a new provider as retired too", async () => {
    fake.rows.push(priceRow({ provider: "openrouter", effectiveFrom: FROM }));
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed({ provider: "anthropic" })],
      retireAbsent: true,
    });
    expect(result).toMatchObject({ written: 1, superseded: 1, retired: 0 });
    expect(fake.rows.filter((r) => r.effectiveTo === null)).toHaveLength(1);
  });
});

describe("the negotiated write path refuses in a shape every surface can classify", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    store.tx = makeFakePriceTx(fake);
  });

  // A bare Error reaches the API and MCP surfaces as an unclassified 500 and
  // the app as `kernel_failure`, because all three classify on `code`. These
  // are caller-actionable refusals, so each must carry one.
  it("refuses to end a rate the organization never negotiated, as a conflict", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));

    await expect(
      closeNegotiatedPriceEntry({ ...SET, at: T1 }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_not_negotiated",
    });
  });

  it("refuses to end a rate before a window that has already begun, as a conflict", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: usdPerMillionToMicros(2.4),
      effectiveFrom: T2,
    });

    // The write instant is after T2, so the row is in force and ending the
    // rate at T1 would reprice a window that has shipped.
    await expect(
      closeNegotiatedPriceEntry({
        ...SET,
        at: T1,
        now: new Date("2026-10-15T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_ends_before_it_starts",
    });
    expect(fake.rows).toHaveLength(1);
  });

  // The same call before T2 arrives is not a refusal: the row has not begun,
  // nothing was priced against it, and ending the rate at T1 means it never
  // applies — so it is cancelled rather than left to start anyway.
  it("cancels a scheduled rate that has not begun when the rate is ended before it starts", async () => {
    const scheduled = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: usdPerMillionToMicros(2.4),
      effectiveFrom: T2,
    });
    const result = await closeNegotiatedPriceEntry({
      ...SET,
      at: T1,
      now: new Date("2026-09-20T00:00:00.000Z"),
    });
    expect(result.closed).toBeNull();
    expect(result.cancelled.map((e) => e.id)).toEqual([scheduled.entry.id]);
    expect(fake.rows).toHaveLength(0);
  });

  it("refuses to reopen a window the organization already ended, as a conflict", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: usdPerMillionToMicros(2.4),
      effectiveFrom: T1,
    });
    await closeNegotiatedPriceEntry({ ...SET, at: T2 });

    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: usdPerMillionToMicros(1),
        effectiveFrom: T1,
      }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_already_ended",
    });
  });
});

describe("nextPriceBookBoundary", () => {
  // `now` is read before the catalogs and the transaction, so a sync that
  // took effect from `now` closed the old row behind frames already priced
  // against it. A future boundary cannot be observed early.
  it("is the next top of the hour, strictly after now", () => {
    const now = new Date("2026-09-18T15:07:42.123Z");
    expect(nextPriceBookBoundary(now)).toEqual(
      new Date("2026-09-18T16:00:00.000Z"),
    );
  });

  it("moves a full hour when now is exactly on a boundary", () => {
    const now = new Date("2026-09-18T15:00:00.000Z");
    expect(nextPriceBookBoundary(now)).toEqual(
      new Date("2026-09-18T16:00:00.000Z"),
    );
  });

  // A boundary only seconds ahead cannot hold through catalog reads and the
  // transaction. Inside the last margin of an hour the run takes the hour
  // after, so the boundary is still ahead when the commit lands.
  it("skips a boundary too close to hold through the refresh", () => {
    const now = new Date("2026-09-18T15:57:30.000Z");
    expect(nextPriceBookBoundary(now)).toEqual(
      new Date("2026-09-18T17:00:00.000Z"),
    );
  });

  it("always answers at least the margin ahead", () => {
    for (const iso of [
      "2026-09-18T15:00:00.000Z",
      "2026-09-18T15:54:59.999Z",
      "2026-09-18T15:55:00.000Z",
      "2026-09-18T15:59:59.999Z",
    ]) {
      const now = new Date(iso);
      expect(
        nextPriceBookBoundary(now).getTime() - now.getTime(),
      ).toBeGreaterThanOrEqual(BOUNDARY_MARGIN_MS);
    }
  });

  // Stable across a retry: a run and its retry a few seconds later write
  // the same instant, so the row-key upsert stays idempotent.
  it("answers the same instant for a retry moments later", () => {
    expect(nextPriceBookBoundary(new Date("2026-09-18T15:00:01Z"))).toEqual(
      nextPriceBookBoundary(new Date("2026-09-18T15:04:00Z")),
    );
  });

  it("crosses midnight into the next UTC day", () => {
    expect(nextPriceBookBoundary(new Date("2026-09-18T23:30:00Z"))).toEqual(
      new Date("2026-09-19T00:00:00.000Z"),
    );
  });
});

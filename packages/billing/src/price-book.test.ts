import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  listPriceEntries,
  BOUNDARY_MARGIN_MS,
  COLD_BOOK_EFFECTIVE_FROM,
  nextPriceBookBoundary,
  priceBookBoundaries,
  priceEntriesFromRateCards,
  resolvePriceEntry,
  setNegotiatedPriceEntry,
  syncPriceBook as syncPriceBookLive,
  usdPerMillionToMicros,
  usdPerUnitToMicrosPerMillion,
  type PriceEntry,
  type PriceEntrySeed,
} from "./price-book";
import {
  initializationRow,
  makeFakePriceStore,
  fakeClock,
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

  it("matches a stamp, an alias, and the family behind a gateway prefix", () => {
    const book = [list, family];
    const q = (modelId: string) =>
      resolvePriceEntry(book, {
        orgId: ORG,
        modelId,
        tokenClass: "input_uncached",
        at,
      })?.id;
    expect(q("claude-sonnet-5-20260901")).toBe("list-sonnet");
    expect(q("claude-sonnet-4-20260401")).toBe("list-sonnet-4");
    // `claude-sonnet-4-6` is its own row in the card at its own price, so it is
    // its own identity: unpriced here rather than billed at the `-4` rate.
    expect(q("claude-sonnet-4-6")).toBe(undefined);
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

  // A negotiated `gpt-4` is not a rate for `gpt-4o`. The resolver reads the
  // organization's rows before the list rows and returns the first name that
  // matched, so on leading characters alone a `gpt-4o` call took the
  // organization's `gpt-4` rate and never reached the more specific `gpt-4o`
  // list row: a frontier model billed at an older model's contracted price,
  // on every affected call. The prefix has to end on a segment boundary.
  it("does not let a negotiated prefix price a distinct model", () => {
    const negotiatedFour = entry({
      id: "neg-gpt-4",
      model: "gpt-4",
      orgId: ORG,
      source: "negotiated",
      microsPerMillion: 1_000_000n,
    });
    const listFourO = entry({ id: "list-gpt-4o", model: "gpt-4o" });
    const q = (modelId: string) =>
      resolvePriceEntry([listFourO, negotiatedFour], {
        orgId: ORG,
        modelId,
        tokenClass: "input_uncached",
        at,
      })?.id;
    expect(q("gpt-4o")).toBe("list-gpt-4o");
    // Nor does the `gpt-4o` list row price the mini: `mini` is a separately
    // priced product, so with no row of its own it is unpriced.
    expect(q("gpt-4o-mini")).toBe(undefined);
    // The stamped snapshots of the product it did negotiate still take the
    // rate, which is what the stamp rule exists for.
    expect(q("gpt-4")).toBe("neg-gpt-4");
    expect(q("gpt-4-0613")).toBe("neg-gpt-4");
    // And with no row for the other model at all, it is unpriced rather than
    // priced from the neighbour that shares a stem.
    expect(
      resolvePriceEntry([negotiatedFour], {
        orgId: ORG,
        modelId: "gpt-4o",
        tokenClass: "input_uncached",
        at,
      }),
    ).toBeNull();
  });

  // The third round on the same comparison. `gpt-4o-mini` is a tenth of
  // `gpt-4o`, and both differ from it by a hyphen and one token — exactly as
  // `gpt-4o-2026-08-01` does, which IS the same product. A boundary test
  // cannot tell them apart, so inheritance is restricted to a point-in-time
  // stamp: an organization that negotiated `gpt-4o` was being billed its
  // premium rate for every cheap mini call.
  it("does not let a negotiated model price a different product that shares its name", () => {
    const negotiatedFourO = entry({
      id: "neg-gpt-4o",
      model: "gpt-4o",
      orgId: ORG,
      source: "negotiated",
      microsPerMillion: 1_000_000n,
    });
    const listMini = entry({
      id: "list-gpt-4o-mini",
      model: "gpt-4o-mini",
      microsPerMillion: 150_000n,
    });
    const q = (modelId: string) =>
      resolvePriceEntry([listMini, negotiatedFourO], {
        orgId: ORG,
        modelId,
        tokenClass: "input_uncached",
        at,
      })?.id;
    expect(q("gpt-4o-mini")).toBe("list-gpt-4o-mini");
    expect(q("gpt-4o-mini-2026-08-01")).toBe("list-gpt-4o-mini");
    // The dated release of the model it DID negotiate still takes the rate.
    expect(q("gpt-4o")).toBe("neg-gpt-4o");
    expect(q("gpt-4o-2026-08-01")).toBe("neg-gpt-4o");
    // With no mini row at all it is unpriced — a null cost the Pricing tab
    // shows as a gap, not the wrong rate billed silently.
    expect(
      resolvePriceEntry([negotiatedFourO], {
        orgId: ORG,
        modelId: "gpt-4o-mini",
        tokenClass: "input_uncached",
        at,
      }),
    ).toBeNull();
  });

  // The fourth round on the same comparison, and the round that overturned the
  // rule the third one wrote. A numeric suffix looked like a version, so a
  // negotiated `gpt-5` priced `gpt-5.2` and `gpt-5.5` too. The card in
  // `pricing.ts` prices them as three products: `gpt-5` $1.25/$10, `gpt-5.2`
  // $1.75/$14, `gpt-5.5` $5/$30. A release is a different product, not one
  // product at a moment, so only a date or snapshot stamp inherits now.
  it("does not let a negotiated model price a separately priced numeric release", () => {
    const negotiatedFive = entry({
      id: "neg-gpt-5",
      model: "gpt-5",
      orgId: ORG,
      source: "negotiated",
      microsPerMillion: 1_000_000n,
    });
    const listTwo = entry({
      id: "list-gpt-5-2",
      model: "gpt-5.2",
      microsPerMillion: 1_750_000n,
    });
    const q = (modelId: string) =>
      resolvePriceEntry([listTwo, negotiatedFive], {
        orgId: ORG,
        modelId,
        tokenClass: "input_uncached",
        at,
      })?.id;
    expect(q("gpt-5.2")).toBe("list-gpt-5-2");
    expect(q("gpt-5.2-2026-08-01")).toBe("list-gpt-5-2");
    // The stamped snapshots of `gpt-5` itself still take the negotiated rate.
    expect(q("gpt-5")).toBe("neg-gpt-5");
    expect(q("gpt-5-2026-08-01")).toBe("neg-gpt-5");
    // And with no row for the other release, it reads as unpriced. A null cost
    // the Pricing tab shows beats the wrong rate billed in silence.
    const onlyNegotiated = (modelId: string) =>
      resolvePriceEntry([negotiatedFive], {
        orgId: ORG,
        modelId,
        tokenClass: "input_uncached",
        at,
      });
    expect(onlyNegotiated("gpt-5.2")).toBeNull();
    expect(onlyNegotiated("gpt-5.5")).toBeNull();
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

/**
 * The sync refuses a boundary the write instant has already passed, and
 * these fixtures use fixed instants. Unless a test pins its own clock, the
 * write instant is one second before the requested boundary, so the boundary
 * is always just ahead, as it is for a real run.
 */
const TEST_NOW = new Date(T1.getTime() - 1_000);
const syncPriceBook: typeof syncPriceBookLive = (args) => {
  // One clock for the whole file, a second before T1: every fixture instant
  // is then ahead of the write, and the cold-start window (measured from the
  // book's first row) does not silently expire between T1 and T2 fixtures
  // three weeks apart. A test that needs a different clock passes its own.
  const now = args.now ?? TEST_NOW;
  // The fake stamps `created_at` from this clock too, as Postgres's `now()`
  // would inside the same transaction.
  fakeClock.now = now;
  return syncPriceBookLive({ now, ...args });
};

describe("the negotiated write path", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    fakeClock.now = null;
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

  it("cancels one future correction, restores its predecessor, and retains the later correction", async () => {
    const t3 = new Date("2026-11-01T00:00:00Z");
    const first = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 100n,
      effectiveFrom: T1,
    });
    const middle = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 200n,
      effectiveFrom: T2,
    });
    const last = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 300n,
      effectiveFrom: t3,
    });
    const now = new Date("2026-09-15T00:00:00Z");
    const result = await closeNegotiatedPriceEntry({
      ...SET,
      now,
      scheduledEntryId: middle.entry.id,
    });
    expect(result.closed).toBeNull();
    expect(result.cancelled.map((row) => row.id)).toEqual([middle.entry.id]);
    expect(
      book().find((row) => row.id === first.entry.id)?.effectiveTo,
    ).toEqual(t3);
    expect(book().find((row) => row.id === last.entry.id)).toEqual(last.entry);
    expect(priceAt(T2)?.microsPerMillion).toBe(100n);
    expect(priceAt(t3)?.microsPerMillion).toBe(300n);
    expect(
      (
        await closeNegotiatedPriceEntry({
          ...SET,
          now,
          scheduledEntryId: middle.entry.id,
        })
      ).cancelled,
    ).toEqual([]);
    await expect(
      closeNegotiatedPriceEntry({
        ...SET,
        now,
        scheduledEntryId: first.entry.id,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_already_started" });
  });

  it("does not cancel an ID belonging to another organization or model key", async () => {
    const future = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 200n,
      effectiveFrom: T2,
    });
    for (const over of [
      { orgId: "00000000-0000-4000-8000-000000000002" },
      { model: "other-model" },
    ]) {
      expect(
        (
          await closeNegotiatedPriceEntry({
            ...SET,
            ...over,
            scheduledEntryId: future.entry.id,
          })
        ).cancelled,
      ).toEqual([]);
      expect(book().some((row) => row.id === future.entry.id)).toBe(true);
    }
  });

  it("refuses cancellation when restoring the predecessor would overlap another identity", async () => {
    const first = await setNegotiatedPriceEntry({
      ...SET,
      modelAliases: ["alias-model"],
      microsPerMillion: 100n,
      effectiveFrom: T1,
    });
    const future = await setNegotiatedPriceEntry({
      ...SET,
      modelAliases: [],
      microsPerMillion: 200n,
      effectiveFrom: T2,
    });
    fake.rows.push(
      priceRow({
        orgId: ORG,
        source: "negotiated",
        model: "alias-model",
        effectiveFrom: T2,
      }),
    );
    await expect(
      closeNegotiatedPriceEntry({ ...SET, scheduledEntryId: future.entry.id }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
    expect(
      book().find((row) => row.id === first.entry.id)?.effectiveTo,
    ).toEqual(T2);
    expect(book().some((row) => row.id === future.entry.id)).toBe(true);
  });

  it("includes only this organization's future negotiated rows when requested", async () => {
    const future = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 200n,
      effectiveFrom: T2,
    });
    fake.rows.push(
      priceRow({ effectiveFrom: T2, source: "list", orgId: null }),
    );
    fake.rows.push(
      priceRow({
        effectiveFrom: T2,
        source: "negotiated",
        orgId: "00000000-0000-4000-8000-000000000002",
      }),
    );
    expect(await listPriceEntries({ orgId: ORG, at: T1 })).toEqual([]);
    expect(
      (
        await listPriceEntries({ orgId: ORG, at: T1, includeScheduled: true })
      ).map((row) => row.id),
    ).toEqual([future.entry.id]);
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
      at: T2,
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
    const closeLocks = fake.log
      .filter((l) => l.op === "lock")
      .map((l) => l.sql);
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

  // A key priced only by the list is nothing of this organization's to end:
  // the list row is never touched, and the answer is the null close a
  // never-negotiated key gets (the retry case is proven further down).
  it("leaves the list row alone and answers a null close", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));

    const out = await closeNegotiatedPriceEntry({ ...SET, at: T2 });
    expect(out).toEqual({ at: T2, closed: null, cancelled: [] });
    expect(fake.rows).toHaveLength(1);
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
    // The class lock, then the one identity this write answers to. The lock
    // is keyed on the identity rather than the spelling, so a write for
    // `vendor/foo` and a write for `foo` take the same second lock and
    // serialise even though they share no name.
    expect(locks).toHaveLength(2);
    expect(locks[0]).toContain("price_entry_class:");
    expect(locks[1]).toContain("price_entry:");
    expect(locks[1]).toContain("foo|output|");
    expect(locks[1]).not.toContain("vendor/foo|output|");

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

  // `resolvePriceEntry` tries the id as given and then the bare family behind
  // a `creator/` prefix, so a row spelled `foo` prices a frame that reports
  // `vendor/foo`. Two rows under the two spellings are therefore one model
  // carrying two contracted rates, and which one a frame gets is decided by
  // the spelling the harness happened to record. Comparing the names as
  // written never saw it, because the two rows share no name.
  it("refuses a second negotiated row for the same model under a gateway prefix (negative)", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      model: "foo",
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
      code: "conflict",
      reason: "price_entry_alias_conflict",
    });
    expect(fake.rows).toHaveLength(1);
  });

  // The other direction, and between two gateways. Neither row is the bare
  // family, so a check that only stripped the incoming name would still let
  // the second one in.
  it("refuses a bare-family row under a live prefixed one, and a second gateway's spelling (negative)", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      model: "vendor/foo",
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        model: "foo",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        model: "gateway/foo",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
    expect(fake.rows).toHaveLength(1);

    // Ending the live rate frees the identity for either spelling.
    await closeNegotiatedPriceEntry({ ...SET, model: "vendor/foo", at: T2 });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        model: "foo",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).resolves.toMatchObject({ closed: null });
  });

  // `resolvePriceEntry` picks rows with `isSameModelIdentity`, which treats a
  // point-in-time stamp as the same product. So a live `gpt-4` row and a
  // second row for `gpt-4-0613` are one model at two contracted rates: the
  // stamped row answers a frame that reports the stamp (the longer match) and
  // the family row answers a bare frame. The overlap check compares identities
  // with the same rule, in both directions.
  it("refuses a stamped negotiated row beside a live family row, and the reverse (negative)", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      provider: "openai",
      model: "gpt-4",
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    // The stamp under a live family row.
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "openai",
        model: "gpt-4-0613",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "price_entry_alias_conflict",
    });
    // An ISO stamp, and a stamp reached through an alias rather than the model.
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "openai",
        model: "vendor/gpt-4-2026-08-01",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "openai",
        model: "unrelated-model",
        modelAliases: ["gpt-4-latest"],
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
    expect(fake.rows).toHaveLength(1);
  });

  // The other direction: the stamped row is the live one and the bare family
  // is written after it. Comparing one way only would let this through.
  it("refuses a family negotiated row under a live stamped one (negative)", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      provider: "openai",
      model: "gpt-4-0613",
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "openai",
        model: "gpt-4",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).rejects.toMatchObject({ reason: "price_entry_alias_conflict" });
    expect(fake.rows).toHaveLength(1);

    // Ending the stamped rate frees the identity.
    await closeNegotiatedPriceEntry({
      ...SET,
      provider: "openai",
      model: "gpt-4-0613",
      at: T2,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "openai",
        model: "gpt-4",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).resolves.toMatchObject({ closed: null });
  });

  // A numeric release is a different product the vendor prices separately, so
  // the widened check must not refuse it. `isSameModelIdentity` is the rule in
  // both places, which is what keeps these two rates apart.
  it("leaves two numeric releases as separate negotiated rates", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      provider: "openai",
      model: "gpt-5",
      microsPerMillion: 1_250_000n,
      effectiveFrom: T1,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "openai",
        model: "gpt-5.2",
        microsPerMillion: 1_750_000n,
        effectiveFrom: T2,
      }),
    ).resolves.toMatchObject({ closed: null });
    expect(fake.rows).toHaveLength(2);
  });

  // The family is spelled EXACTLY, never matched by the resolver's prefix
  // rule, so two models that merely share a stem stay two rates. Normalising
  // with `startsWith` here would refuse `gpt-4` for an unrelated `gpt-4o`.
  it("leaves two models that only share a stem as separate negotiated rates", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      provider: "openai",
      model: "openai/gpt-4o",
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await expect(
      setNegotiatedPriceEntry({
        ...SET,
        provider: "openai",
        model: "gpt-4",
        microsPerMillion: 2_000_000n,
        effectiveFrom: T2,
      }),
    ).resolves.toMatchObject({ closed: null });
    expect(fake.rows).toHaveLength(2);
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

  // The lock wait is unbounded: another negotiated write can hold the class
  // lock until a scheduled start has passed. A write instant read before the
  // wait then let a correction to the row at that start pass the
  // shipped-window check and change, in place, the terms of a row that
  // priced frames during the wait. These drive the real clock (no injected
  // `now`) and move it while the lock is held.
  describe("the write instant is read under the locks", () => {
    const before = new Date("2026-09-09T23:59:00.000Z");
    const after = new Date("2026-09-10T00:00:30.000Z");

    afterEach(() => {
      vi.useRealTimers();
      fake.onLock = undefined;
    });

    it("refuses a correction whose window began while the write waited on the lock (negative)", async () => {
      await setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_400_000n,
        effectiveFrom: T1,
      });
      vi.useFakeTimers();
      vi.setSystemTime(before);
      fake.onLock = () => vi.setSystemTime(after);
      await expect(
        setNegotiatedPriceEntry({
          ...SET,
          now: undefined,
          microsPerMillion: 2_000_000n,
          effectiveFrom: T1,
        }),
      ).rejects.toMatchObject({
        name: "HandlerError",
        code: "conflict",
        reason: "price_entry_already_effective",
      });
      expect(fake.rows).toHaveLength(1);
      expect(fake.rows[0]!.microsPerMillion).toBe(2_400_000n);
    });

    it("starts an omitted effectiveFrom at the instant after the wait, not before it", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(before);
      fake.onLock = () => vi.setSystemTime(after);
      const written = await setNegotiatedPriceEntry({
        ...SET,
        now: undefined,
        microsPerMillion: 2_400_000n,
      });
      expect(written.entry.effectiveFrom).toEqual(after);
    });

    it("ends an omitted `at` at the instant after the wait, so nothing shipped during it is repriced", async () => {
      const first = await setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_400_000n,
        effectiveFrom: new Date("2026-09-08T00:00:00.000Z"),
      });
      vi.useFakeTimers();
      vi.setSystemTime(before);
      fake.onLock = () => vi.setSystemTime(after);
      const ended = await closeNegotiatedPriceEntry({ ...SET, now: undefined });
      expect(ended.at).toEqual(after);
      expect(ended.closed?.id).toBe(first.entry.id);
      expect(ended.closed?.effectiveTo).toEqual(after);
      // Every frame up to the instant the row actually closed still prices
      // against it.
      expect(priceAt(before)?.id).toBe(first.entry.id);
      expect(priceAt(after)?.id).toBe(undefined);
    });

    it("refuses a cutoff that fell into the past while the removal waited on the lock (negative)", async () => {
      await setNegotiatedPriceEntry({
        ...SET,
        microsPerMillion: 2_400_000n,
        effectiveFrom: new Date("2026-09-08T00:00:00.000Z"),
      });
      vi.useFakeTimers();
      vi.setSystemTime(before);
      fake.onLock = () => vi.setSystemTime(after);
      // The caller sampled its own clock before the request: by the time the
      // lock is held that instant is in the past, and a rollup during the
      // wait may have priced a frame against the row.
      await expect(
        closeNegotiatedPriceEntry({ ...SET, now: undefined, at: before }),
      ).rejects.toMatchObject({
        name: "HandlerError",
        code: "conflict",
        reason: "price_entry_window_shipped",
      });
      expect(fake.rows[0]!.effectiveTo).toBeNull();
    });
  });
});

describe("syncPriceBook supersedes a row whose provider changed", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    fakeClock.now = null;
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
      // The boundary itself has passed, which is refused before any row is
      // looked at: the same defect, caught one step earlier.
      reason: "price_book_boundary_passed",
    });
    expect(fake.rows[0]!.microsPerMillion).toBe(3_000_000n);

    // A boundary that has passed is refused whatever the terms: the refusal
    // is about the instant, decided before any row is compared.
    await expect(
      syncPriceBook({
        effectiveFrom: T1,
        seeds: [seed(3_000_000n, T1)],
        now: new Date("2026-09-10T00:30:00.000Z"),
      }),
    ).rejects.toMatchObject({ reason: "price_book_boundary_passed" });

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
        createdAt: new Date("2026-09-08T00:00:00.000Z"),
      }),
    );
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
    expect(result.superseded).toBe(1);
    const renamed = fake.rows.find((r) => r.provider === "anthropic");
    expect(renamed?.effectiveFrom).toEqual(T1);
    const old = fake.rows.find((r) => r.provider === "openrouter");
    expect(old?.effectiveTo).toEqual(T1);
  });

  // The obligation to reprice is read off the book, not off what a run wrote.
  // The rows commit before `cost/price-book.backdated` is sent, so a send that
  // fails leaves the book seeded and the repricing unrequested — and keyed on
  // `written`, the retry and every hourly sync after it read a correct book,
  // wrote nothing, and asked for nothing. The floored rows those runs left
  // alone are exactly what still needs repricing, so the report names them.
  it("reports the floored rows in force, so a run that writes nothing still owes the repricing", async () => {
    fake.rows.push(
      priceRow({
        effectiveFrom: COLD_BOOK_EFFECTIVE_FROM,
        createdAt: new Date("2026-09-08T00:00:00.000Z"),
      }),
    );
    const unchanged = await syncPriceBook({
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
    expect(unchanged.written).toBe(0);
    expect(unchanged.unchanged).toBe(1);
    expect(unchanged.coldStart).toBe(true);
    expect(unchanged.hasBackdatedRows).toBe(true);
  });

  // The inverse: a cold book with nothing floored prices nothing that has
  // already run, however many rows the run wrote at its own boundary, so no
  // repricing is owed and none is asked for.
  it("reports no floored rows when a cold run wrote only at its own boundary", async () => {
    fake.rows.push(
      priceRow({
        effectiveFrom: new Date("2026-09-08T00:00:00.000Z"),
        createdAt: new Date("2026-09-08T00:00:00.000Z"),
      }),
    );
    const written = await syncPriceBook({
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
          microsPerMillion: 4_000_000n,
          effectiveFrom: T1,
          effectiveTo: null,
        },
      ],
    });
    expect(written.written).toBe(1);
    expect(written.coldStart).toBe(true);
    expect(written.hasBackdatedRows).toBe(false);
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
      (r) =>
        (r.effectiveFrom as Date).getTime() ===
        COLD_BOOK_EFFECTIVE_FROM.getTime(),
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
      // models.dev was down at the first sync, so the card is the only source
      // that answered, and that is what the initialization record says.
      completedCatalogs: ["in_code_card"],
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
          catalog: "in_code_card",
        },
      ],
    });
    expect(result.coldStart).toBe(true);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.effectiveFrom).toEqual(COLD_BOOK_EFFECTIVE_FROM);
    // The run that created the book recorded what answered at it, because no
    // later read of the rows can reconstruct that set.
    expect(fake.initializations).toHaveLength(1);
    expect(fake.initializations[0]).toMatchObject({
      book: "list",
      completedCatalogs: ["in_code_card"],
    });
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

    // A repricing of a key already priced takes the requested instant. The
    // floor row has priced every frame since the first sync, so it closes
    // there and a successor carries the new rate; it is never rewritten.
    const again = await syncPriceBook({
      effectiveFrom: T2,
      retireAbsent: true,
      completedCatalogs: ["in_code_card"],
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
          catalog: "in_code_card",
        },
      ],
    });
    expect(again.coldStart).toBe(true);
    const floorRow = fake.rows.find(
      (r) =>
        (r.effectiveFrom as Date).getTime() ===
        COLD_BOOK_EFFECTIVE_FROM.getTime(),
    )!;
    expect(floorRow.microsPerMillion).toBe(3_000_000n);
    expect(floorRow.effectiveTo).toEqual(T2);
    const successor = fake.rows.find((r) => r.effectiveTo === null)!;
    expect(successor.effectiveFrom).toEqual(T2);
    expect(successor.microsPerMillion).toBe(2_000_000n);
    // That successor is not proof that initialization completed. Only the
    // window is, so a key from the source that wrote nothing at initialization
    // is still backdated.
    const T3 = new Date(T2.getTime() + 3_600_000);
    const still = await syncPriceBook({
      effectiveFrom: T3,
      completedCatalogs: ["in_code_card", "models_dev"],
      seeds: [
        {
          provider: "openai",
          model: "gpt-9",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 1_000_000n,
          effectiveFrom: T3,
          effectiveTo: null,
          catalog: "models_dev",
        },
      ],
    });
    expect(still.coldStart).toBe(true);
    expect(fake.rows.find((r) => r.model === "gpt-9")!.effectiveFrom).toEqual(
      COLD_BOOK_EFFECTIVE_FROM,
    );
  });

  // models.dev down, and an OpenRouter rate moves. That repricing once ended
  // cold start, so the models recovered from models.dev on a later run
  // started at that later boundary, and calls made before the recovery
  // stayed unpriced for good. The repair of that, correcting the floor row in
  // place, changed settled costs under the same entry id. Now the floor row
  // closes and a successor carries the rate, and the book stays cold.
  it("stays cold through a repricing on a partial run, so a later recovery still backdates", async () => {
    const seedFor = (
      model: string,
      micros: bigint,
      at: Date,
      catalog = "openrouter",
    ): PriceEntrySeed => ({
      provider: "anthropic",
      model,
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: micros,
      effectiveFrom: at,
      effectiveTo: null,
      catalog,
    });
    // First sync, partial: one catalog's model, at the floor. models.dev was
    // down, so the record names only OpenRouter.
    await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seedFor("claude-sonnet-5", 3_000_000n, T1)],
      retireAbsent: false,
      completedCatalogs: ["openrouter"],
    });
    // Second sync, still partial, but that model's rate moved.
    const repriced = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [seedFor("claude-sonnet-5", 2_500_000n, T2)],
      retireAbsent: false,
      completedCatalogs: ["openrouter"],
    });
    expect(repriced.coldStart).toBe(true);
    // The floor row, which every frame so far was priced with, is untouched
    // except for its close; the new rate is a successor at T2.
    expect(fake.rows[0]!.microsPerMillion).toBe(3_000_000n);
    expect(fake.rows[0]!.effectiveTo).toEqual(T2);
    const successor = fake.rows.find((r) => r.effectiveTo === null)!;
    expect(successor.effectiveFrom).toEqual(T2);
    expect(successor.microsPerMillion).toBe(2_500_000n);
    // Third sync, the other catalog recovers: its model is backdated too.
    const T3 = new Date(T2.getTime() + 3_600_000);
    const recovered = await syncPriceBook({
      effectiveFrom: T3,
      seeds: [
        seedFor("claude-sonnet-5", 2_500_000n, T3),
        seedFor("gpt-9", 1_000_000n, T3, "models_dev"),
      ],
      retireAbsent: true,
      completedCatalogs: ["openrouter", "models_dev"],
    });
    expect(recovered.coldStart).toBe(true);
    expect(fake.rows.find((r) => r.model === "gpt-9")!.effectiveFrom).toEqual(
      COLD_BOOK_EFFECTIVE_FROM,
    );
  });

  // A first sync that ran with a catalog down seeds only the card's models.
  // If that alone ended cold start, the catalog's models would arrive at
  // recovery time and calls made before recovery would stay unpriced.
  it("stays cold after a partial first sync, so a model a recovered catalog adds is backdated too", async () => {
    const seed = (model: string, catalog = "in_code_card"): PriceEntrySeed => ({
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
      catalog,
    });
    // First tick: only the card answered, and the record says so.
    await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed("card-model")],
      completedCatalogs: ["in_code_card"],
    });
    // Next tick: the catalog is back and names a model the book never saw.
    const result = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [seed("card-model"), seed("catalog-model", "openrouter")],
      completedCatalogs: ["in_code_card", "openrouter"],
    });
    expect(result.coldStart).toBe(true);
    expect(
      fake.rows.find((r) => r.model === "catalog-model")!.effectiveFrom,
    ).toEqual(COLD_BOOK_EFFECTIVE_FROM);
    expect(result.unchanged).toBe(1);
  });

  // The overrides are read completely on every run. One for a key the book
  // has never priced is not a catalog recovering; it is terms the operator
  // introduced after an earlier snapshot, and flooring it changed what the
  // frames since that snapshot cost on a rollup retry. Only the first sync
  // of an empty book floors an override.
  it("starts an override introduced while the book is cold at the requested boundary, not the floor", async () => {
    const seed = (
      model: string,
      over: Partial<PriceEntrySeed> = {},
    ): PriceEntrySeed => ({
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
      ...over,
    });
    const override = {
      source: "override",
      catalog: "operator_override",
    } as const;
    // First sync of an empty book: an override present from the start is
    // floored, like everything else in the first snapshot.
    const first = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        seed("card-model", { catalog: "in_code_card" }),
        seed("day-one-override", override),
      ],
      // The catalog was down at the first sync, so the record names only the
      // card and the operator's own overrides.
      completedCatalogs: ["in_code_card", "operator_override"],
    });
    expect(first.coldStart).toBe(true);
    expect(
      fake.rows.find((r) => r.model === "day-one-override")!.effectiveFrom,
    ).toEqual(COLD_BOOK_EFFECTIVE_FROM);

    // Next tick, still cold: the operator adds an override for a model the
    // book never priced, and a catalog comes back with a model of its own.
    const result = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [
        seed("card-model", { catalog: "in_code_card" }),
        seed("day-one-override", override),
        seed("new-override", override),
        seed("catalog-model", { catalog: "openrouter" }),
      ],
      completedCatalogs: ["in_code_card", "operator_override", "openrouter"],
    });
    expect(result.coldStart).toBe(true);
    const byModel = (m: string) => fake.rows.find((r) => r.model === m)!;
    expect(byModel("new-override").effectiveFrom).toEqual(T2);
    expect(byModel("new-override").source).toBe("override");
    // The catalog's model is still backdated: that is what cold start is for.
    expect(byModel("catalog-model").effectiveFrom).toEqual(
      COLD_BOOK_EFFECTIVE_FROM,
    );
    expect(result.unchanged).toBe(2);
    expect(result.written).toBe(2);
  });

  // The cold-start window said WHEN initialization might still be
  // recovering, never from WHAT. A source that answered at the first sync and
  // publishes a new model days later is publishing a model that did not exist
  // before, not recovering one it always priced. Flooring it handed the new
  // rate to every frame recorded since the first sync, on the reprice pass or
  // on a later rollup retry, so costs that had settled changed.
  it("starts a model added by a source that answered at initialization at the requested boundary", async () => {
    const seed = (
      model: string,
      catalog: string,
      at: Date,
    ): PriceEntrySeed => ({
      provider: "anthropic",
      model,
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: 2_000_000n,
      effectiveFrom: at,
      effectiveTo: null,
      catalog,
    });
    // A complete first sync: both sources answered, and both stamp their rows.
    await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        seed("card-model", "in_code_card", T1),
        seed("catalog-model", "openrouter", T1),
      ],
      retireAbsent: true,
      completedCatalogs: ["in_code_card", "openrouter"],
    });
    // Still well inside the window, and the card names a model it never had.
    const result = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [
        seed("card-model", "in_code_card", T2),
        seed("catalog-model", "openrouter", T2),
        seed("card-newcomer", "in_code_card", T2),
      ],
      retireAbsent: true,
      completedCatalogs: ["in_code_card", "openrouter"],
    });
    // The window has not passed, so the run is still cold. The floor is what
    // no longer applies, not the window.
    expect(result.coldStart).toBe(true);
    expect(
      fake.rows.find((r) => r.model === "card-newcomer")!.effectiveFrom,
    ).toEqual(T2);
  });

  // The floor still exists for what it was built for: a catalog that was down
  // when the book was written, coming back with models it had priced all
  // along. Calls made before that recovery must price at the rate it brings.
  it("still backdates a model from a source that wrote nothing at initialization", async () => {
    const seed = (
      model: string,
      catalog: string,
      at: Date,
    ): PriceEntrySeed => ({
      provider: "anthropic",
      model,
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: 2_000_000n,
      effectiveFrom: at,
      effectiveTo: null,
      catalog,
    });
    // A partial first sync: models.dev was down, so only the card wrote.
    await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed("card-model", "in_code_card", T1)],
      retireAbsent: false,
      completedCatalogs: ["in_code_card"],
    });
    // It comes back naming a model of its own.
    const result = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [
        seed("card-model", "in_code_card", T2),
        seed("recovered-model", "models_dev", T2),
      ],
      retireAbsent: true,
      completedCatalogs: ["in_code_card", "models_dev"],
    });
    expect(result.coldStart).toBe(true);
    expect(
      fake.rows.find((r) => r.model === "recovered-model")!.effectiveFrom,
    ).toEqual(COLD_BOOK_EFFECTIVE_FROM);
  });

  // The reconstruction this replaced read the answering sources off the rows:
  // the `catalog` stamped on the rows created at the book's earliest instant.
  // `mergePublishedPrices` gives each model to one source outright, so a
  // catalog that answered at the first sync and lost every model to a
  // higher-precedence source contributes no row, and the rows cannot tell it
  // from a catalog that was down. Its first unique model inside the window was
  // then floored as a recovery, and the next rollup changed what runs that had
  // already sealed cost. The record says which sources answered; precedence
  // does not filter it.
  it("does not floor a model from a catalog that answered at initialization and won nothing", async () => {
    const seed = (
      model: string,
      catalog: string,
      at: Date,
    ): PriceEntrySeed => ({
      provider: "anthropic",
      model,
      modelAliases: [],
      region: null,
      tokenClass: "input_uncached",
      unit: "token",
      currency: "USD",
      microsPerMillion: 2_000_000n,
      effectiveFrom: at,
      effectiveTo: null,
      catalog,
    });
    // A complete first sync: both catalogs answered. OpenRouter lost every one
    // of its models to the card, so the book carries no OpenRouter row.
    const first = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed("card-model", "in_code_card", T1)],
      retireAbsent: true,
      completedCatalogs: ["in_code_card", "openrouter"],
    });
    expect(first.coldStart).toBe(true);
    expect(fake.rows.every((r) => r.catalog === "in_code_card")).toBe(true);
    // The record carries both, which is the fact the rows cannot carry.
    expect(fake.initializations[0]!.completedCatalogs).toEqual([
      "in_code_card",
      "openrouter",
    ]);

    // Still inside the window, and OpenRouter names a model of its own for the
    // first time. It answered at initialization, so this is a model that did
    // not exist then, not a recovery: it starts at the requested boundary.
    const result = await syncPriceBook({
      effectiveFrom: T2,
      seeds: [
        seed("card-model", "in_code_card", T2),
        seed("openrouter-newcomer", "openrouter", T2),
      ],
      retireAbsent: true,
      completedCatalogs: ["in_code_card", "openrouter"],
    });
    expect(result.coldStart).toBe(true);
    expect(
      fake.rows.find((r) => r.model === "openrouter-newcomer")!.effectiveFrom,
    ).toEqual(T2);
    // The only floored row is the one the first sync wrote. The new rate is
    // not among them, so no rollup can move a settled cost onto it.
    expect(
      fake.rows
        .filter(
          (r) =>
            (r.effectiveFrom as Date).getTime() ===
            COLD_BOOK_EFFECTIVE_FROM.getTime(),
        )
        .map((r) => r.model),
    ).toEqual(["card-model"]);
  });

  // A book written before `price_book_initializations` existed has no record,
  // and the record is precisely the fact its rows cannot answer. So nothing is
  // floored on that book: an unpriced frame is visible in the unpriced-models
  // report and can be priced forward, while a repriced settled run is silent.
  it("floors nothing on a book that has no initialization record", async () => {
    fake.rows.push(
      priceRow({
        model: "claude-sonnet-5",
        effectiveFrom: COLD_BOOK_EFFECTIVE_FROM,
        createdAt: TEST_NOW,
        catalog: "in_code_card",
      }),
    );
    expect(fake.initializations).toHaveLength(0);

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
          catalog: "in_code_card",
        },
        {
          provider: "openai",
          model: "gpt-9",
          modelAliases: [],
          region: null,
          tokenClass: "input_uncached",
          unit: "token",
          currency: "USD",
          microsPerMillion: 1_000_000n,
          effectiveFrom: T1,
          effectiveTo: null,
          catalog: "models_dev",
        },
      ],
      completedCatalogs: ["in_code_card", "models_dev"],
    });
    // The window is still open, read off the earliest row as it was before the
    // record existed, so the run is cold.
    expect(result.coldStart).toBe(true);
    // The new key starts at the requested boundary. Floored, it would have
    // priced every frame since the book was written, and the next rollup would
    // have changed what those runs cost.
    expect(fake.rows.find((r) => r.model === "gpt-9")!.effectiveFrom).toEqual(
      T1,
    );
    // No record is invented for the book either: the fact is unknown, and a
    // guess is what caused the defect.
    expect(fake.initializations).toHaveLength(0);
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
    fakeClock.now = null;
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
      seeds: [seed({ effectiveFrom: BOUNDARY })],
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

  // A partial first sync left the book cold; a later refresh waited on the
  // lock until its boundary passed. Exempting the whole cold transaction let
  // that refresh close a repriced key's floor row in the past, and frames
  // rolled up during the wait cited a window that no longer covered them.
  it("holds the boundary on a cold book for every write that lands at a real instant", async () => {
    const late = new Date(T1.getTime() + 60_000);
    fake.rows.push(
      priceRow({
        model: "claude-sonnet-5",
        effectiveFrom: COLD_BOOK_EFFECTIVE_FROM,
        createdAt: TEST_NOW,
        catalog: "models_dev",
      }),
    );
    // The book's initialization, with OpenRouter down at it, so a key
    // OpenRouter names here is a recovery and lands at the floor.
    fake.initializations.push(
      initializationRow({
        initializedAt: TEST_NOW,
        completedCatalogs: ["models_dev"],
      }),
    );
    // A key already priced, at a changed rate: its successor would land at
    // T1, which has passed. Refused, and the floor row is left as it was.
    await expect(
      syncPriceBook({
        effectiveFrom: T1,
        seeds: [seed({ microsPerMillion: 2_000_000n })],
        now: late,
      }),
    ).rejects.toMatchObject({ reason: "price_book_boundary_passed" });
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.effectiveTo).toBeNull();
    // A retirement closes at the boundary too.
    await expect(
      syncPriceBook({
        effectiveFrom: T1,
        seeds: [],
        retireAbsent: true,
        completedCatalogs: ["models_dev"],
        now: late,
      }),
    ).rejects.toMatchObject({ reason: "price_book_boundary_passed" });
    expect(fake.rows[0]!.effectiveTo).toBeNull();
    // A key the book has never priced lands at the floor, below every
    // frame, and is the one write the passed boundary does not touch.
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [
        seed({ catalog: "models_dev" }),
        seed({
          model: "gpt-9",
          microsPerMillion: 1_000_000n,
          catalog: "openrouter",
        }),
      ],
      now: late,
    });
    expect(result.coldStart).toBe(true);
    expect(result.written).toBe(1);
    expect(fake.rows.find((r) => r.model === "gpt-9")!.effectiveFrom).toEqual(
      COLD_BOOK_EFFECTIVE_FROM,
    );
  });

  // The lock wait is unbounded. A clock read before it passed the boundary
  // check with a stale time, and a sync that waited past its own boundary
  // committed a retroactive change.
  it("reads the write instant after the lock, so a long wait cannot pass a stale boundary check", async () => {
    // Drives the real clock path (no injected `now`): time moves while the
    // lock is held.
    const BOUNDARY = new Date("2026-09-18T16:00:00.000Z");
    const before = new Date("2026-09-18T15:59:00.000Z");
    const after = new Date("2026-09-18T16:00:30.000Z");
    // A warm book: cold start is exempt from the boundary check by design.
    fake.rows.push(
      priceRow({
        model: "gpt-9",
        effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(before);
    fake.onLock = () => vi.setSystemTime(after);
    fakeClock.now = before;
    try {
      await expect(
        syncPriceBookLive({ effectiveFrom: BOUNDARY, seeds: [seed()] }),
      ).rejects.toMatchObject({ reason: "price_book_boundary_passed" });
    } finally {
      vi.useRealTimers();
      fake.onLock = undefined;
    }
    expect(fake.rows).toHaveLength(1);
  });

  // The overrides are this installation's own environment, read completely on
  // every run. An override the operator removed is a rate that ended whatever
  // the catalogs did, and holding it open until every catalog answered kept
  // billing on terms the operator withdrew, for as long as an outage lasted.
  it("retires a withdrawn override on a run where a catalog was down", async () => {
    fake.rows.push(
      priceRow({
        model: "claude-sonnet-4",
        source: "override",
        catalog: "operator_override",
      }),
      // A row from the catalog that failed is still protected.
      priceRow({
        model: "claude-haiku-4",
        source: "list",
        catalog: "models_dev",
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed()],
      retireAbsent: false,
      completedCatalogs: ["operator_override", "in_code_card", "openrouter"],
    });
    expect(result.retired).toBe(1);
    const byModel = (m: string) => fake.rows.find((r) => r.model === m)!;
    expect(byModel("claude-sonnet-4").effectiveTo).toEqual(T1);
    expect(byModel("claude-haiku-4").effectiveTo).toBeNull();
  });

  // The operator removed an override whose terms matched the catalog to the
  // micro. The row stayed tagged `override`, and on the next partial run the
  // override-retirement pass closed it as a removed override, leaving the
  // model unpriced until every catalog answered.
  it("re-stamps a row's source in place when only its author changed", async () => {
    fake.rows.push(priceRow({ source: "override" }));
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed({ source: "list" })],
    });
    expect(result.unchanged).toBe(1);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.source).toBe("list");
    expect(fake.rows[0]!.effectiveTo).toBeNull();
  });

  // models.dev down, OpenRouter answered and withdrew a model. Deciding
  // retirement book-wide kept the OpenRouter row open for as long as the
  // unrelated catalog stayed down, and runs used a withdrawn rate.
  it("retires a row its own catalog withdrew while another catalog is down", async () => {
    fake.rows.push(
      priceRow({ model: "withdrawn-by-openrouter", catalog: "openrouter" }),
      priceRow({ model: "owned-by-models-dev", catalog: "models_dev" }),
      // Written before the column existed: retired only on a complete run.
      priceRow({ model: "legacy-unstamped", catalog: null }),
    );
    const result = await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed()],
      retireAbsent: false,
      completedCatalogs: ["operator_override", "in_code_card", "openrouter"],
    });
    expect(result.retired).toBe(1);
    const byModel = (m: string) => fake.rows.find((r) => r.model === m)!;
    expect(byModel("withdrawn-by-openrouter").effectiveTo).toEqual(T1);
    expect(byModel("owned-by-models-dev").effectiveTo).toBeNull();
    expect(byModel("legacy-unstamped").effectiveTo).toBeNull();
  });

  it("stamps the catalog on every row it writes, and re-stamps one that matched", async () => {
    fake.rows.push(priceRow({ catalog: null }));
    await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed({ catalog: "openrouter" })],
    });
    expect(fake.rows[0]!.catalog).toBe("openrouter");
  });

  it("records which rows came from an override, so they can be told apart later", async () => {
    await syncPriceBook({
      effectiveFrom: T1,
      seeds: [seed({ model: "negotiated-model", source: "override" }), seed()],
    });
    expect(fake.rows.find((r) => r.model === "negotiated-model")?.source).toBe(
      "override",
    );
    expect(fake.rows.find((r) => r.model === "claude-sonnet-5")?.source).toBe(
      "list",
    );
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

describe("syncPriceBook closes a row whose names another row now prices", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    fakeClock.now = null;
    store.tx = makeFakePriceTx(fake);
  });

  // An established book: past the cold-start window, so nothing is floored
  // and every write lands at the requested boundary.
  const ESTABLISHED = new Date("2026-01-01T00:00:00.000Z");
  const NOW = new Date("2026-09-18T15:10:00.000Z");
  const AT = new Date("2026-09-18T16:00:00.000Z");

  const seed = (over: Partial<PriceEntrySeed> = {}): PriceEntrySeed => ({
    provider: "anthropic",
    model: "foo",
    modelAliases: [],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 1_000_000n,
    effectiveFrom: AT,
    effectiveTo: null,
    source: "override",
    catalog: "operator_override",
    ...over,
  });

  const stale = () =>
    priceRow({
      provider: "openrouter",
      model: "anthropic/foo",
      catalog: "openrouter",
      microsPerMillion: 5_000_000n,
      effectiveFrom: FROM,
      createdAt: ESTABLISHED,
    });

  // The operator adds a bare-family override while the catalog that
  // published the gateway-form row is down. Supersession compares canonical
  // keys and retirement protects the failed catalog's row, so both passes
  // left it open. `resolvePriceEntry` resolves `anthropic/foo` on the direct
  // pass, where only the stale row matches, and never reaches the family
  // pass where the override would win: the override was ignored for as long
  // as the catalog stayed down.
  it("closes a gateway-form row a bare override now prices, while its catalog is down", async () => {
    fake.rows.push(stale());
    const result = await syncPriceBook({
      effectiveFrom: AT,
      now: NOW,
      seeds: [seed()],
      retireAbsent: false,
      completedCatalogs: ["operator_override", "in_code_card"],
    });
    expect(result.coldStart).toBe(false);
    // Not a retirement: the failed catalog's rows are still protected from
    // being closed for absence alone.
    expect(result.retired).toBe(0);
    expect(result.superseded).toBe(1);
    expect(
      fake.rows.find((r) => r.model === "anthropic/foo")!.effectiveTo,
    ).toEqual(AT);
    const book: PriceEntry[] = fake.rows.map((r) => ({
      ...(r as unknown as PriceEntry),
    }));
    const hit = resolvePriceEntry(book, {
      orgId: ORG,
      modelId: "anthropic/foo",
      tokenClass: "input_uncached",
      at: AT,
    });
    expect(hit?.source).toBe("override");
    expect(hit?.microsPerMillion).toBe(1_000_000n);
  });

  // The class the override does not restate. An override that states input and
  // output leaves the down catalog's cache rows behind, and keyed by class as
  // well as by name nothing displaced them: cached calls went on billing at
  // the stale catalog rate the override had replaced, under the same model the
  // operator had just repriced. A source that wins a model states what it
  // costs in every class, including by omission, so the classes it does not
  // restate close at its instant and read `estimated` instead.
  it("closes the classes an override omits, not only the ones it restates", async () => {
    fake.rows.push(stale());
    fake.rows.push(
      priceRow({
        provider: "openrouter",
        model: "anthropic/foo",
        catalog: "openrouter",
        tokenClass: "cache_read",
        microsPerMillion: 500_000n,
        effectiveFrom: FROM,
        createdAt: ESTABLISHED,
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: AT,
      now: NOW,
      // Input and output only: the override says nothing about cache reads.
      seeds: [
        seed(),
        seed({ tokenClass: "output", microsPerMillion: 3_000_000n }),
      ],
      retireAbsent: false,
      completedCatalogs: ["operator_override", "in_code_card"],
    });
    expect(result.retired).toBe(0);
    expect(result.superseded).toBe(2);
    for (const row of fake.rows.filter((r) => r.model === "anthropic/foo"))
      expect(row.effectiveTo).toEqual(AT);
    const book: PriceEntry[] = fake.rows.map((r) => ({
      ...(r as unknown as PriceEntry),
    }));
    // The cache read is unpriced from the override's instant, which the rollup
    // records as `estimated`. Billing it at the rate the override replaced is
    // the thing this must not do.
    expect(
      resolvePriceEntry(book, {
        orgId: ORG,
        modelId: "anthropic/foo",
        tokenClass: "cache_read",
        at: AT,
      }),
    ).toBeNull();
    // The classes the override did state are priced by the override.
    expect(
      resolvePriceEntry(book, {
        orgId: ORG,
        modelId: "anthropic/foo",
        tokenClass: "output",
        at: AT,
      })?.microsPerMillion,
    ).toBe(3_000_000n);
  });

  // The names a seed answers to include its aliases, because the resolver
  // matches on them too.
  it("closes a row displaced by a name the seed carries as an alias", async () => {
    fake.rows.push(stale());
    const result = await syncPriceBook({
      effectiveFrom: AT,
      now: NOW,
      seeds: [seed({ model: "bar", modelAliases: ["foo"] })],
      retireAbsent: false,
      completedCatalogs: ["operator_override"],
    });
    expect(result.superseded).toBe(1);
    expect(
      fake.rows.find((r) => r.model === "anthropic/foo")!.effectiveTo,
    ).toEqual(AT);
  });

  // An override is the operator's own terms and outranks every catalog. A
  // catalog seed that happens to name the same family does not end it.
  it("never lets a catalog seed displace an operator's override (negative)", async () => {
    fake.rows.push(
      priceRow({
        provider: "anthropic",
        model: "anthropic/foo",
        source: "override",
        catalog: "operator_override",
        microsPerMillion: 5_000_000n,
        effectiveFrom: FROM,
        createdAt: ESTABLISHED,
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: AT,
      now: NOW,
      seeds: [
        seed({ provider: "openrouter", source: "list", catalog: "openrouter" }),
      ],
      retireAbsent: false,
      completedCatalogs: ["openrouter"],
    });
    expect(result.superseded).toBe(0);
    expect(
      fake.rows.find((r) => r.model === "anthropic/foo")!.effectiveTo,
    ).toBeNull();
  });

  // Only a gateway-form seed that does NOT claim the bare family leaves the
  // bare row open. A bare row answers ids that seed cannot match, so closing
  // it would leave them unpriced for as long as its catalog stayed down.
  it("keeps a bare row from a failed catalog when the seed names only the gateway form (negative)", async () => {
    fake.rows.push(
      priceRow({
        provider: "openrouter",
        model: "foo",
        catalog: "openrouter",
        effectiveFrom: FROM,
        createdAt: ESTABLISHED,
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: AT,
      now: NOW,
      seeds: [seed({ model: "anthropic/foo" })],
      retireAbsent: false,
      completedCatalogs: ["operator_override", "in_code_card"],
    });
    expect(result.superseded).toBe(0);
    expect(result.retired).toBe(0);
    expect(fake.rows.find((r) => r.model === "foo")!.effectiveTo).toBeNull();
  });

  // The reverse of the gateway-form case: catalog published bare `foo`, then
  // failed while the operator added an override for `vendor/foo` whose default
  // alias claims `foo`. Skipping every bare name before consulting seedByName
  // left those classes billing at the stale catalog rate (Codex P1 on #3271).
  it("closes a bare row a prefixed override's alias now claims, while its catalog is down", async () => {
    fake.rows.push(
      priceRow({
        provider: "openrouter",
        model: "foo",
        catalog: "openrouter",
        microsPerMillion: 5_000_000n,
        effectiveFrom: FROM,
        createdAt: ESTABLISHED,
      }),
    );
    fake.rows.push(
      priceRow({
        provider: "openrouter",
        model: "foo",
        catalog: "openrouter",
        tokenClass: "cache_read",
        microsPerMillion: 500_000n,
        effectiveFrom: FROM,
        createdAt: ESTABLISHED,
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: AT,
      now: NOW,
      // Prefixed override that also claims the bare family, stating input only.
      seeds: [
        seed({
          model: "anthropic/foo",
          modelAliases: ["foo"],
          microsPerMillion: 1_000_000n,
        }),
      ],
      retireAbsent: false,
      completedCatalogs: ["operator_override", "in_code_card"],
    });
    expect(result.retired).toBe(0);
    expect(result.superseded).toBe(2);
    for (const row of fake.rows.filter((r) => r.model === "foo"))
      expect(row.effectiveTo).toEqual(AT);
    const book: PriceEntry[] = fake.rows.map((r) => ({
      ...(r as unknown as PriceEntry),
    }));
    expect(
      resolvePriceEntry(book, {
        orgId: ORG,
        modelId: "foo",
        tokenClass: "cache_read",
        at: AT,
      }),
    ).toBeNull();
    expect(
      resolvePriceEntry(book, {
        orgId: ORG,
        modelId: "anthropic/foo",
        tokenClass: "input_uncached",
        at: AT,
      })?.microsPerMillion,
    ).toBe(1_000_000n);
  });

  // The family has to be spelled exactly. The resolver's prefix rule is
  // deliberately loose, and closing `openai/gpt-4o` because some seed prices
  // `gpt-4` would throw away the more specific price for a different model.
  it("leaves a gateway-form row alone when a seed only shares its stem (negative)", async () => {
    fake.rows.push(
      priceRow({
        provider: "openai",
        model: "openai/gpt-4o",
        catalog: "openrouter",
        effectiveFrom: FROM,
        createdAt: ESTABLISHED,
      }),
    );
    const result = await syncPriceBook({
      effectiveFrom: AT,
      now: NOW,
      seeds: [seed({ model: "gpt-4" })],
      retireAbsent: false,
      completedCatalogs: ["operator_override"],
    });
    expect(result.superseded).toBe(0);
    expect(
      fake.rows.find((r) => r.model === "openai/gpt-4o")!.effectiveTo,
    ).toBeNull();
  });
});

describe("the negotiated write path refuses in a shape every surface can classify", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    fakeClock.now = null;
    store.tx = makeFakePriceTx(fake);
  });

  // Refusing a key with no negotiated row broke the retry: a call that
  // cancelled the only (scheduled) row deleted it and succeeded, and its
  // retry found nothing and threw. The list row is untouched either way,
  // and a null close claims nothing was removed.
  it("answers a null close for a key the organization never negotiated, and leaves the list row alone", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));

    const out = await closeNegotiatedPriceEntry({ ...SET, at: T1 });
    expect(out.closed).toBeNull();
    expect(out.cancelled).toEqual([]);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]!.effectiveTo).toBeNull();
  });

  it("retries a cancellation as a no-op once the scheduled row is gone", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: usdPerMillionToMicros(2.4),
      effectiveFrom: T2,
      now: T1,
    });
    const first = await closeNegotiatedPriceEntry({ ...SET, at: T1, now: T1 });
    expect(first.cancelled).toHaveLength(1);
    expect(first.closed).toBeNull();
    const again = await closeNegotiatedPriceEntry({ ...SET, at: T1, now: T1 });
    expect(again).toEqual({ at: T1, closed: null, cancelled: [] });
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

describe("priceBookBoundaries", () => {
  const T2 = new Date("2026-09-02T00:00:00.000Z");
  const T3 = new Date("2026-09-03T00:00:00.000Z");
  const T4 = new Date("2026-09-04T00:00:00.000Z");

  it("returns both ends of every window, ascending and deduplicated", () => {
    const book = [
      entry({ id: "a", model: "claude-sonnet-5", effectiveTo: T3 }),
      entry({ id: "b", model: "claude-sonnet-5", effectiveFrom: T3 }),
      entry({
        id: "c",
        model: "claude-sonnet-5",
        tokenClass: "output",
        effectiveTo: T3,
      }),
    ];
    expect(priceBookBoundaries(book)).toEqual([FROM.getTime(), T3.getTime()]);
  });

  it("keeps inclusive in-window endpoints without discarding an overlapping rate", () => {
    const book = [
      entry({
        id: "a",
        model: "claude-sonnet-5",
        effectiveFrom: FROM,
        effectiveTo: T2,
      }),
      entry({
        id: "b",
        model: "claude-sonnet-5",
        effectiveFrom: T2,
        effectiveTo: T3,
      }),
      entry({
        id: "c",
        model: "claude-sonnet-5",
        effectiveFrom: T3,
        effectiveTo: T4,
      }),
      entry({ id: "d", model: "claude-sonnet-5", effectiveFrom: T4 }),
    ];
    expect(priceBookBoundaries(book, { since: T2, until: T3 })).toEqual([
      T2.getTime(),
      T3.getTime(),
    ]);
    expect(priceBookBoundaries(book)).toEqual([
      FROM.getTime(),
      T2.getTime(),
      T3.getTime(),
      T4.getTime(),
    ]);
    expect(priceBookBoundaries(book, { since: T3, until: T3 })).toEqual([
      T3.getTime(),
    ]);
    expect(
      priceBookBoundaries(
        [
          entry({
            id: "a",
            model: "claude-sonnet-5",
            effectiveFrom: FROM,
            effectiveTo: T3,
          }),
        ],
        {
          since: T2,
          until: T3,
        },
      ),
    ).toEqual([T3.getTime()]);
  });

  it("supports either report bound independently and an empty window", () => {
    const book = [
      entry({
        id: "a",
        model: "claude-sonnet-5",
        effectiveFrom: FROM,
        effectiveTo: T4,
      }),
    ];
    expect(priceBookBoundaries(book, { since: T2 })).toEqual([T4.getTime()]);
    expect(priceBookBoundaries(book, { until: T3 })).toEqual([FROM.getTime()]);
    expect(priceBookBoundaries(book, { since: T2, until: T3 })).toEqual([]);
  });

  // The observed-usage read scans this array once per frame, so a boundary
  // that no observed model could ever be priced at is both a per-frame cost
  // and a bucket split whose two sides answer identically. An organization
  // running one model must not pay for every other model's rate changes.
  it("keeps only the rows that could price one of the named models", () => {
    const book = [
      entry({ id: "a", model: "claude-sonnet-5", effectiveTo: T2 }),
      entry({ id: "b", model: "gpt-5", effectiveTo: T3 }),
      entry({ id: "c", model: "gemini-3", effectiveTo: T4 }),
    ];
    expect(priceBookBoundaries(book, { models: ["claude-sonnet-5"] })).toEqual([
      FROM.getTime(),
      T2.getTime(),
    ]);
    expect(priceBookBoundaries(book, { models: [] })).toEqual([]);
    // Unfiltered is still every boundary, so the default is unchanged.
    expect(priceBookBoundaries(book)).toHaveLength(4);
  });

  // The narrowing uses the resolver's own matching, never a loose prefix
  // test, so it can neither drop a boundary the resolver would honour nor
  // keep one for a model that merely shares a stem.
  it("matches a model the way the resolver does, family fallback and stamp included", () => {
    const book = [
      entry({ id: "a", model: "claude-sonnet-5", effectiveTo: T2 }),
      entry({ id: "b", model: "gpt-4", effectiveTo: T3 }),
      entry({
        id: "c",
        model: "legacy",
        modelAliases: ["vendor-brand-new"],
        effectiveTo: T4,
      }),
    ];
    // `anthropic/claude-sonnet-5` reaches the bare family, the way
    // `resolvePriceEntryFromClassBook` falls back to it.
    expect(
      priceBookBoundaries(book, { models: ["anthropic/claude-sonnet-5"] }),
    ).toEqual([FROM.getTime(), T2.getTime()]);
    // A point-in-time stamp is the same product.
    expect(
      priceBookBoundaries(book, { models: ["claude-sonnet-5-20260901"] }),
    ).toEqual([FROM.getTime(), T2.getTime()]);
    // `gpt-4` prefixes `gpt-4o` and prices nothing of it.
    expect(priceBookBoundaries(book, { models: ["gpt-4o"] })).toEqual([]);
    // An alias reaches its row.
    expect(priceBookBoundaries(book, { models: ["vendor-brand-new"] })).toEqual(
      [FROM.getTime(), T4.getTime()],
    );
  });

  // A token read never observes `image` or `video_second` usage, so those
  // rows' boundaries can only split a bucket nobody probes.
  it("keeps only the named token classes", () => {
    const book = [
      entry({ id: "a", model: "m", tokenClass: "output", effectiveTo: T2 }),
      entry({ id: "b", model: "m", tokenClass: "image", effectiveTo: T3 }),
    ];
    expect(
      priceBookBoundaries(book, { tokenClasses: ["output", "input_uncached"] }),
    ).toEqual([FROM.getTime(), T2.getTime()]);
  });
});

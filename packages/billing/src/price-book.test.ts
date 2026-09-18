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
  priceEntriesFromRateCards,
  resolvePriceEntry,
  setNegotiatedPriceEntry,
  syncPriceBook,
  usdPerMillionToMicros,
  usdPerUnitToMicrosPerMillion,
  type PriceEntry,
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

const SET = {
  orgId: ORG,
  provider: "anthropic",
  model: "claude-sonnet-5",
  tokenClass: "input_uncached",
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

  it("is idempotent on the row key, and a re-set at the same instant corrects in place", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T1,
    });
    expect(fake.rows).toHaveLength(1);

    // Same key, corrected before it shipped: the row is updated, not doubled.
    const again = await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_000_000n,
      effectiveFrom: T1,
    });
    expect(fake.rows).toHaveLength(1);
    expect(again.entry.microsPerMillion).toBe(2_000_000n);
    expect(again.closed).toBeNull();
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

    const closed = await closeNegotiatedPriceEntry({ ...SET, at: T2 });
    expect(closed?.effectiveTo).toEqual(T2);
    // Closed, not deleted: the row and its price are still there.
    expect(fake.rows).toHaveLength(2);
    expect(
      priceAt(new Date("2026-09-20T00:00:00.000Z"))?.microsPerMillion,
    ).toBe(2_400_000n);
    expect(priceAt(T2)?.microsPerMillion).toBe(3_000_000n);
    expect(priceAt(T2)?.source).toBe("list");

    // Re-ending what is already ended is a no-op, so a retry is safe.
    expect(await closeNegotiatedPriceEntry({ ...SET, at: T2 })).toBeNull();
  });

  it("refuses to touch the list row", async () => {
    fake.rows.push(priceRow({ microsPerMillion: 3_000_000n }));

    await expect(closeNegotiatedPriceEntry({ ...SET, at: T2 })).rejects.toThrow(
      /not an organization's to change/,
    );
    expect(fake.rows[0]!.effectiveTo).toBeNull();
    expect(fake.rows[0]!.source).toBe("list");
  });

  it("refuses to end a rate at or before it starts", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: 2_400_000n,
      effectiveFrom: T2,
    });
    await expect(closeNegotiatedPriceEntry({ ...SET, at: T2 })).rejects.toThrow(
      /cannot end at or before it starts/,
    );
  });
});

describe("syncPriceBook supersedes a row whose provider changed", () => {
  let fake: FakePriceStore;

  beforeEach(() => {
    fake = makeFakePriceStore();
    store.tx = makeFakePriceTx(fake);
  });

  const openRows = () => fake.rows.filter((r) => r.effectiveTo === null);

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

  it("refuses to end a rate at or before it starts, as a conflict", async () => {
    await setNegotiatedPriceEntry({
      ...SET,
      microsPerMillion: usdPerMillionToMicros(2.4),
      effectiveFrom: T2,
    });

    await expect(
      closeNegotiatedPriceEntry({ ...SET, at: T1 }),
    ).rejects.toMatchObject({
      name: "HandlerError",
      code: "conflict",
      reason: "price_entry_ends_before_it_starts",
    });
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

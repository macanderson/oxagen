// unpriced-models.test.ts — the diff between the models an organization runs
// and the prices anyone has stated for them. Pure: no price book store, no
// frame store, so the ordering and the partial-miss rule are exercised
// directly rather than inferred from a query.
import { describe, expect, it } from "vitest";
import { findUnpricedModels, type ObservedModel } from "./unpriced-models";
import type { PriceEntry, PriceTokenClass } from "./price-book";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000002";
const AT = new Date("2026-09-14T12:00:00.000Z");
const FROM = new Date("2026-09-01T00:00:00.000Z");

/** The classes a token model needs priced before it stops being a question. */
const REQUIRED: PriceTokenClass[] = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "output",
];

let id = 0;

function entry(over: Partial<PriceEntry> = {}): PriceEntry {
  id += 1;
  return {
    id: `0192d4a8-7c1e-7a00-8000-${String(id).padStart(12, "0")}`,
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    tokenClass: "input_uncached",
    unit: "token",
    currency: "USD",
    microsPerMillion: 3_000_000n,
    effectiveFrom: FROM,
    effectiveTo: null,
    source: "list",
    ...over,
  };
}

/** A full list price for one model: every required class. */
function fullyPriced(model: string, over: Partial<PriceEntry> = {}) {
  return REQUIRED.map((tokenClass) => entry({ model, tokenClass, ...over }));
}

function observed(over: Partial<ObservedModel> = {}): ObservedModel {
  return {
    model: "some-new-model",
    provider: "openai",
    calls: 3,
    tokens: 1_000,
    firstSeen: new Date("2026-09-10T00:00:00.000Z"),
    lastSeen: new Date("2026-09-13T00:00:00.000Z"),
    ...over,
  };
}

describe("findUnpricedModels", () => {
  it("leaves out a model the book prices in every class", () => {
    const out = findUnpricedModels({
      observed: [observed({ model: "claude-sonnet-5" })],
      book: fullyPriced("claude-sonnet-5"),
      orgId: ORG,
      at: AT,
    });
    expect(out).toEqual([]);
  });

  it("names a model nothing prices, with every class missing", () => {
    const out = findUnpricedModels({
      observed: [observed({ model: "vendor/brand-new" })],
      book: fullyPriced("claude-sonnet-5"),
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      model: "vendor/brand-new",
      provider: "openai",
      calls: 3,
      tokens: 1_000,
      missingClasses: REQUIRED,
      fullyUnpriced: true,
    });
    // The observation is carried through, not re-derived.
    expect(out[0]!.firstSeen).toEqual(new Date("2026-09-10T00:00:00.000Z"));
    expect(out[0]!.lastSeen).toEqual(new Date("2026-09-13T00:00:00.000Z"));
  });

  it("reports a partly-priced model as not fully unpriced, naming only the gaps", () => {
    // A card that priced input and output but never the cache tiers: the run
    // is `estimated`, not blank, so it must not sort above a model with no
    // price at all.
    const book = [
      entry({ model: "half-priced", tokenClass: "input_uncached" }),
      entry({ model: "half-priced", tokenClass: "output" }),
    ];
    const out = findUnpricedModels({
      observed: [observed({ model: "half-priced" })],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.missingClasses).toEqual(["cache_read", "cache_write_5m"]);
    expect(out[0]!.fullyUnpriced).toBe(false);
  });

  it("counts a class the organization's own negotiated row prices", () => {
    // The list prices three classes; the organization negotiated the fourth.
    // Nobody needs to be told about a model it has a rate for.
    const book = [
      entry({ model: "negotiated-model", tokenClass: "input_uncached" }),
      entry({ model: "negotiated-model", tokenClass: "cache_read" }),
      entry({ model: "negotiated-model", tokenClass: "cache_write_5m" }),
      entry({
        model: "negotiated-model",
        tokenClass: "output",
        orgId: ORG,
        source: "negotiated",
      }),
    ];
    expect(
      findUnpricedModels({
        observed: [observed({ model: "negotiated-model" })],
        book,
        orgId: ORG,
        at: AT,
      }),
    ).toEqual([]);
  });

  it("does not let another organization's negotiated row price this one's model", () => {
    const book = [
      entry({ model: "negotiated-model", tokenClass: "input_uncached" }),
      entry({ model: "negotiated-model", tokenClass: "cache_read" }),
      entry({ model: "negotiated-model", tokenClass: "cache_write_5m" }),
      entry({
        model: "negotiated-model",
        tokenClass: "output",
        orgId: OTHER_ORG,
        source: "negotiated",
      }),
    ];
    const out = findUnpricedModels({
      observed: [observed({ model: "negotiated-model" })],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.missingClasses).toEqual(["output"]);
  });

  it("ignores an entry that is not effective at the read instant", () => {
    const book = fullyPriced("retired-price", {
      effectiveTo: new Date("2026-09-05T00:00:00.000Z"),
    });
    const out = findUnpricedModels({
      observed: [observed({ model: "retired-price" })],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out[0]!.fullyUnpriced).toBe(true);
  });

  it("orders fully unpriced first, then by tokens run, then by model id", () => {
    const partial = [
      entry({ model: "partial-huge", tokenClass: "input_uncached" }),
      entry({ model: "partial-huge", tokenClass: "output" }),
    ];
    const out = findUnpricedModels({
      observed: [
        // Partly priced, and by far the biggest — still below every model
        // with no price at all.
        observed({ model: "partial-huge", tokens: 9_000_000 }),
        observed({ model: "b-small", tokens: 10 }),
        observed({ model: "a-tie", tokens: 500 }),
        observed({ model: "big", tokens: 5_000 }),
        observed({ model: "b-tie", tokens: 500 }),
      ],
      book: partial,
      orgId: ORG,
      at: AT,
    });
    expect(out.map((m) => m.model)).toEqual([
      "big",
      "a-tie",
      "b-tie",
      "b-small",
      "partial-huge",
    ]);
    expect(out.at(-1)!.fullyUnpriced).toBe(false);
  });

  it("answers an empty list when nothing has been run", () => {
    expect(
      findUnpricedModels({ observed: [], book: [], orgId: ORG, at: AT }),
    ).toEqual([]);
  });
});

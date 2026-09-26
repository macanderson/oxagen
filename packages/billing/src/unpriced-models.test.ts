// unpriced-models.test.ts — the diff between the models an organization runs
// and the prices anyone has stated for them. Pure: no price book store, no
// frame store, so the ordering and the partial-miss rule are exercised
// directly rather than inferred from a query.
import { describe, expect, it, vi } from "vitest";

// The store half (`readUnpricedModels`) is exercised against a mocked frame
// read: what it hands that read is the whole behaviour under test, and a real
// ClickHouse would prove nothing about it.
const readObservedModelsMock = vi.hoisted(() =>
  vi.fn(async (_args: unknown): Promise<unknown[]> => []),
);
vi.mock("@oxagen/telemetry", () => ({
  readObservedModels: readObservedModelsMock,
  OBSERVED_TOKEN_CLASSES: [
    "input_uncached",
    "cache_read",
    "cache_write_5m",
    "cache_write_1h",
    "output",
    "reasoning",
    "server_tool_request",
  ],
}));

import {
  findUnpricedModels,
  readUnpricedModels,
  UNPRICED_MODEL_READ_PAGE_SIZE,
  UNPRICED_MODEL_REPORT_LIMIT,
  type ObservedModel,
  type ObservedModelClassUsage,
} from "./unpriced-models";
import * as priceBook from "./price-book";
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

/** One class an observed model used, in one bucket, with real tokens. */
function usage(
  over: Partial<ObservedModelClassUsage> = {},
): ObservedModelClassUsage {
  return {
    tokenClass: "input_uncached",
    calls: 1,
    tokens: 500,
    firstSeen: new Date("2026-09-10T00:00:00.000Z"),
    lastSeen: new Date("2026-09-13T00:00:00.000Z"),
    ...over,
  };
}

/** An observation that used every {@link REQUIRED} class, matching `observed`'s totals. */
function requiredUsage(
  over: Partial<Omit<ObservedModelClassUsage, "tokenClass">> = {},
): ObservedModelClassUsage[] {
  return REQUIRED.map((tokenClass) => usage({ tokenClass, ...over }));
}

function observed(over: Partial<ObservedModel> = {}): ObservedModel {
  return {
    model: "some-new-model",
    provider: "openai",
    calls: 3,
    tokens: 1_000,
    firstSeen: new Date("2026-09-10T00:00:00.000Z"),
    lastSeen: new Date("2026-09-13T00:00:00.000Z"),
    classes: requiredUsage(),
    ...over,
  };
}

describe("findUnpricedModels", () => {
  it("leaves out a model the book prices in every class it used", () => {
    const out = findUnpricedModels({
      observed: [observed({ model: "claude-sonnet-5" })],
      book: fullyPriced("claude-sonnet-5"),
      orgId: ORG,
      at: AT,
    });
    expect(out).toEqual([]);
  });

  it("names a model nothing prices, with every class it used missing", () => {
    const out = findUnpricedModels({
      observed: [observed({ model: "vendor/brand-new" })],
      book: fullyPriced("claude-sonnet-5"),
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(1);
    // Missing classes come back sorted, not in observation order.
    const sortedRequired = [...REQUIRED].sort((a, b) => a.localeCompare(b));
    expect(out[0]).toMatchObject({
      model: "vendor/brand-new",
      provider: "openai",
      calls: 3,
      tokens: 1_000,
      missingClasses: sortedRequired,
      fullyUnpriced: true,
    });
    // The observation is carried through, not re-derived.
    expect(out[0]!.firstSeen).toEqual(new Date("2026-09-10T00:00:00.000Z"));
    expect(out[0]!.lastSeen).toEqual(new Date("2026-09-13T00:00:00.000Z"));
    // Each missing class carries the span it went unpriced over.
    expect(out[0]!.missingClassWindows).toEqual(
      sortedRequired.map((tokenClass) => ({
        tokenClass,
        unpricedFrom: new Date("2026-09-10T00:00:00.000Z"),
        unpricedTo: new Date("2026-09-13T00:00:00.000Z"),
        calls: 1,
        units: 500,
      })),
    );
  });

  it("does not check a class the model never used, even when the book has no row for it", () => {
    // A card with input/output priced but no cache rows at all — the model
    // never sent a cached token, so the missing cache rows are not a gap.
    const book = [
      entry({ model: "no-caching", tokenClass: "input_uncached" }),
      entry({ model: "no-caching", tokenClass: "output" }),
    ];
    const out = findUnpricedModels({
      observed: [
        observed({
          model: "no-caching",
          classes: [
            usage({ tokenClass: "input_uncached", tokens: 800 }),
            usage({ tokenClass: "output", tokens: 200 }),
            // Present but zero — a class column with no usage in it, not a
            // class the model used and the book failed to price.
            usage({ tokenClass: "cache_read", tokens: 0 }),
          ],
        }),
      ],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out).toEqual([]);
  });

  it("checks reasoning on the same footing as every other class", () => {
    // A card with every classic class priced but no reasoning rate: the
    // model's thinking tokens make its runs `estimated`, and the fixed list
    // this function used to check never mentioned reasoning at all.
    const book = fullyPriced("thinking-model");
    const out = findUnpricedModels({
      observed: [
        observed({
          model: "thinking-model",
          classes: [
            ...requiredUsage(),
            usage({ tokenClass: "reasoning", tokens: 4_000 }),
          ],
        }),
      ],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.missingClasses).toEqual(["reasoning"]);
    expect(out[0]!.fullyUnpriced).toBe(false);
  });

  it("names a model whose provider-side searches nobody priced, and drops it once a rate covers them", () => {
    // #3281. A wrapped call records the web searches it made
    // (`web_search_requests`) and the book prices them as
    // `server_tool_request` per request. The observation read used to
    // report six token classes and stop, so this usage never reached the
    // comparison: a model billed for every search it ran read as fully
    // priced, and the report the customer opens to find out why a run has no
    // cost said nothing about the one rate that was missing.
    const searching = observed({
      model: "searching-model",
      classes: [
        ...requiredUsage(),
        usage({ tokenClass: "server_tool_request", calls: 2, tokens: 7 }),
      ],
    });

    const unpriced = findUnpricedModels({
      observed: [searching],
      book: fullyPriced("searching-model"),
      orgId: ORG,
      at: AT,
    });
    expect(unpriced).toHaveLength(1);
    expect(unpriced[0]!.missingClasses).toEqual(["server_tool_request"]);
    expect(unpriced[0]!.fullyUnpriced).toBe(false);
    expect(unpriced[0]!.missingClassWindows).toEqual([
      {
        tokenClass: "server_tool_request",
        unpricedFrom: new Date("2026-09-10T00:00:00.000Z"),
        unpricedTo: new Date("2026-09-13T00:00:00.000Z"),
        calls: 2,
        units: 7,
      },
    ]);

    // The rate the report asked for is the rate that silences it.
    expect(
      findUnpricedModels({
        observed: [searching],
        book: [
          ...fullyPriced("searching-model"),
          entry({
            model: "searching-model",
            tokenClass: "server_tool_request",
            unit: "request",
          }),
        ],
        orgId: ORG,
        at: AT,
      }),
    ).toEqual([]);
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

  it("ignores an entry that is not effective at the calls that used it", () => {
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

  // A customer states the first rate for a model after it has produced
  // unpriced calls. The new row prices it from now on; the earlier calls
  // that used it stay blank, and each is checked at the instant it ran, not
  // at `at`.
  it("names a model whose price began after some of its calls ran", () => {
    const book = fullyPriced("late-priced", {
      effectiveFrom: new Date("2026-09-12T00:00:00.000Z"),
    });
    const out = findUnpricedModels({
      observed: [observed({ model: "late-priced" })],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.fullyUnpriced).toBe(true);
    // The same model, with every call after the price began, is priced.
    const after = findUnpricedModels({
      observed: [
        observed({
          model: "late-priced",
          firstSeen: new Date("2026-09-12T00:00:00.000Z"),
          classes: requiredUsage({
            firstSeen: new Date("2026-09-12T00:00:00.000Z"),
            lastSeen: new Date("2026-09-13T00:00:00.000Z"),
          }),
        }),
      ],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(after).toEqual([]);
  });

  // A price that lapsed between two calls, with no call during the lapse, is
  // a gap this organization never actually ran into — the earlier fixed
  // window scan across firstSeen..lastSeen used to flag it anyway.
  it("does not flag a price gap that falls between two calls when nothing ran during it", () => {
    const book = [
      ...fullyPriced("bracketed", {
        effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
        effectiveTo: new Date("2026-01-05T00:00:00.000Z"),
      }),
      ...fullyPriced("bracketed", {
        effectiveFrom: new Date("2026-01-06T00:00:00.000Z"),
      }),
    ];
    // Calls on Jan 1 and Jan 10; the price lapsed only on Jan 5, and nothing
    // called the model that day.
    const out = findUnpricedModels({
      observed: [
        observed({
          model: "bracketed",
          firstSeen: new Date("2026-01-01T00:00:00.000Z"),
          lastSeen: new Date("2026-01-10T00:00:00.000Z"),
          classes: [
            ...requiredUsage({
              firstSeen: new Date("2026-01-01T00:00:00.000Z"),
              lastSeen: new Date("2026-01-01T00:00:00.000Z"),
            }),
            ...requiredUsage({
              firstSeen: new Date("2026-01-10T00:00:00.000Z"),
              lastSeen: new Date("2026-01-10T00:00:00.000Z"),
            }),
          ],
        }),
      ],
      book,
      orgId: ORG,
      at: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(out).toEqual([]);
  });

  it("names a model whose calls actually fell inside the lapsed window", () => {
    const book = [
      ...fullyPriced("gapped", {
        effectiveTo: new Date("2026-09-11T00:00:00.000Z"),
      }),
      ...fullyPriced("gapped", {
        effectiveFrom: new Date("2026-09-12T00:00:00.000Z"),
      }),
    ];
    const out = findUnpricedModels({
      // This bucket's calls (firstSeen == lastSeen) landed AT the lapse, not
      // merely somewhere within the model's wider first/last-call span.
      observed: [
        observed({
          model: "gapped",
          classes: requiredUsage({
            firstSeen: new Date("2026-09-11T12:00:00.000Z"),
            lastSeen: new Date("2026-09-11T12:00:00.000Z"),
          }),
        }),
      ],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out.map((m) => m.model)).toEqual(["gapped"]);
  });

  // A rate that priced a class, then lapsed, then came back: the model has
  // two `output` buckets, one priced and one not. The old rule flagged
  // `fullyUnpriced` on "every USED CLASS missed at least once" — since
  // `output` is the model's only class and it missed once, that read as
  // fully unpriced even though the model's other `output` bucket has real,
  // priced cost. The correct rule is "every USAGE BUCKET missed."
  it("is not fully unpriced when a class has both a priced and an unpriced bucket", () => {
    const book = [
      entry({
        model: "lapsed-then-restored",
        tokenClass: "output",
        effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
        effectiveTo: new Date("2026-09-05T00:00:00.000Z"),
      }),
      entry({
        model: "lapsed-then-restored",
        tokenClass: "output",
        effectiveFrom: new Date("2026-09-12T00:00:00.000Z"),
      }),
    ];
    const out = findUnpricedModels({
      observed: [
        observed({
          model: "lapsed-then-restored",
          firstSeen: new Date("2026-09-02T00:00:00.000Z"),
          lastSeen: new Date("2026-09-13T00:00:00.000Z"),
          classes: [
            // Priced bucket: falls inside the first rate's effective span.
            usage({
              tokenClass: "output",
              firstSeen: new Date("2026-09-02T00:00:00.000Z"),
              lastSeen: new Date("2026-09-02T00:00:00.000Z"),
            }),
            // Unpriced bucket: falls in the lapse between the two rates.
            usage({
              tokenClass: "output",
              firstSeen: new Date("2026-09-08T00:00:00.000Z"),
              lastSeen: new Date("2026-09-08T00:00:00.000Z"),
            }),
            // Priced bucket again: falls inside the second rate's span.
            usage({
              tokenClass: "output",
              firstSeen: new Date("2026-09-13T00:00:00.000Z"),
              lastSeen: new Date("2026-09-13T00:00:00.000Z"),
            }),
          ],
        }),
      ],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.missingClasses).toEqual(["output"]);
    // The lapse bucket is still named as a gap the customer should see...
    expect(out[0]!.missingClassWindows).toEqual([
      {
        tokenClass: "output",
        unpricedFrom: new Date("2026-09-08T00:00:00.000Z"),
        unpricedTo: new Date("2026-09-08T00:00:00.000Z"),
        // Only the lapse bucket counts. The two priced buckets add nothing.
        calls: 1,
        units: 500,
      },
    ]);
    // ...but the model is not blank-cost: two of its three buckets priced.
    expect(out[0]!.fullyUnpriced).toBe(false);
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

  // The report caps how many unpriced models it SHOWS, applied after the
  // price comparison has already decided which models are unpriced — never
  // as a pre-filter on which models are compared.
  it("caps the report after filtering, not before — a low-volume unpriced model below the cutoff is still found", () => {
    const heavyPriced = Array.from(
      { length: UNPRICED_MODEL_REPORT_LIMIT },
      (_, i) =>
        observed({
          model: `priced-${i}`,
          tokens: 1_000_000 - i,
          classes: requiredUsage(),
        }),
    );
    const rareUnpriced = observed({ model: "rare-unpriced", tokens: 5 });
    const book = heavyPriced.flatMap((m) => fullyPriced(m.model));
    const out = findUnpricedModels({
      observed: [...heavyPriced, rareUnpriced],
      book,
      orgId: ORG,
      at: AT,
    });
    expect(out.map((m) => m.model)).toEqual(["rare-unpriced"]);
  });

  it("never reports more than the cap", () => {
    const observedModels = Array.from(
      { length: UNPRICED_MODEL_REPORT_LIMIT + 25 },
      (_, i) => observed({ model: `unpriced-${i}`, tokens: i }),
    );
    const out = findUnpricedModels({
      observed: observedModels,
      book: [],
      orgId: ORG,
      at: AT,
    });
    expect(out).toHaveLength(UNPRICED_MODEL_REPORT_LIMIT);
  });

  // A book holding boundaries and rows for unrelated models must not widen
  // the number of price-book probes one observed model's usage takes: the
  // book is indexed by class once, and each probe is answered from that
  // model's class's slice rather than a rescan of the whole book.
  it("does not rescan unrelated classes or models per probe", () => {
    const resolveSpy = vi.spyOn(priceBook, "resolvePriceEntryFromClassBook");
    const unrelatedBook = Array.from({ length: 50 }, (_, i) =>
      entry({
        model: `unrelated-${i}`,
        tokenClass: "output",
        effectiveFrom: new Date(FROM.getTime() + i * 86_400_000),
      }),
    );
    const book = [...fullyPriced("watched"), ...unrelatedBook];
    resolveSpy.mockClear();
    findUnpricedModels({
      observed: [observed({ model: "watched" })],
      book,
      orgId: ORG,
      at: AT,
    });
    // One probe per class the observed model actually used (four), never
    // one per boundary in the unrelated rows.
    expect(resolveSpy).toHaveBeenCalledTimes(REQUIRED.length);
    resolveSpy.mockRestore();
  });

  // Both axes in one fixture: a class the model never used, and a bucket the
  // model made no call in, are each absent from the observation and neither
  // costs a probe.
  it("probes neither a class with no tokens nor a bucket with no calls", () => {
    const resolveSpy = vi.spyOn(priceBook, "resolvePriceEntryFromClassBook");
    resolveSpy.mockClear();
    findUnpricedModels({
      observed: [
        observed({
          model: "sparse",
          classes: [
            // input_uncached: two buckets, one with real usage and one with
            // none — the empty one is simply absent from `classes`, the way
            // `readObservedModels` reports it (`WHERE tok > 0`).
            usage({
              tokenClass: "input_uncached",
              tokens: 300,
              firstSeen: new Date("2026-09-10T00:00:00.000Z"),
              lastSeen: new Date("2026-09-10T00:00:00.000Z"),
            }),
            // reasoning: present in the row shape but zero tokens — a class
            // this model never actually used.
            usage({ tokenClass: "reasoning", tokens: 0 }),
          ],
        }),
      ],
      book: fullyPriced("sparse"),
      orgId: ORG,
      at: AT,
    });
    // Exactly one probe: the single nonzero (class, bucket) pair.
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelId: "sparse" }),
    );
    resolveSpy.mockRestore();
  });
});

describe("readUnpricedModels", () => {
  const SINCE = new Date("2026-09-01T00:00:00.000Z");
  const LATER = new Date("2026-09-05T00:00:00.000Z");
  const LATEST = new Date("2026-09-07T00:00:00.000Z");

  // `loadPriceBook` returns every list row's full history plus the
  // organization's own. Handing all of it to the frame read makes every frame
  // scan every rate change any model has ever had — O(frames × all history),
  // which times out as the catalog grows — and splits the report into buckets
  // whose price answer is identical on both sides, so an unrelated model's
  // price change fragments a report about a model the org never ran.
  it("hands the frame read only the boundaries the observed models could actually be repriced at", async () => {
    const loadSpy = vi.spyOn(priceBook, "loadPriceBook").mockResolvedValue([
      // The observed model's own token rows: one boundary, at FROM.
      ...fullyPriced("watched"),
      // A model this organization never ran, repriced twice.
      entry({ model: "unrelated", effectiveFrom: LATER, effectiveTo: LATEST }),
      // The observed model, in a class no token frame can ever report.
      entry({
        model: "watched",
        tokenClass: "image",
        effectiveFrom: LATEST,
      }),
    ]);
    let handed: Date[] | null = null;
    readObservedModelsMock.mockImplementation(async (args) => {
      const typed = args as {
        boundariesFor: (models: readonly string[]) => readonly Date[];
      };
      handed = [...typed.boundariesFor(["watched"])];
      return [];
    });

    const out = await readUnpricedModels({ orgId: ORG, since: SINCE, at: AT });

    expect(out).toEqual([]);
    expect(handed).toEqual([FROM]);
    expect(readObservedModelsMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, since: SINCE, until: AT }),
    );
    loadSpy.mockRestore();
  });

  it("bounds the observed-model callback to the report window", async () => {
    const before = new Date(SINCE.getTime() - 1);
    const inside = new Date("2026-09-07T00:00:00.000Z");
    const after = new Date(AT.getTime() + 1);
    const loadSpy = vi.spyOn(priceBook, "loadPriceBook").mockResolvedValue([
      entry({ model: "watched", effectiveFrom: before, effectiveTo: SINCE }),
      entry({ model: "watched", effectiveFrom: SINCE, effectiveTo: inside }),
      entry({ model: "watched", effectiveFrom: inside, effectiveTo: AT }),
      entry({ model: "watched", effectiveFrom: AT, effectiveTo: after }),
      entry({ model: "watched", effectiveFrom: after }),
      entry({
        model: "unrelated",
        effectiveFrom: new Date(inside.getTime() + 1),
      }),
      entry({
        model: "watched",
        tokenClass: "image",
        effectiveFrom: new Date(inside.getTime() + 2),
      }),
    ]);
    let handed: readonly Date[] = [];
    readObservedModelsMock.mockImplementation(async (args) => {
      const typed = args as {
        boundariesFor: (models: readonly string[]) => readonly Date[];
      };
      handed = typed.boundariesFor(["watched"]);
      return [];
    });
    try {
      await readUnpricedModels({ orgId: ORG, since: SINCE, at: AT });
      expect(handed).toEqual([SINCE, inside, AT]);
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("reports what the frame read observed, judged against the book", async () => {
    const loadSpy = vi
      .spyOn(priceBook, "loadPriceBook")
      .mockResolvedValue(fullyPriced("priced"));
    readObservedModelsMock.mockImplementation(async (args) => {
      const typed = args as {
        boundariesFor: (models: readonly string[]) => readonly Date[];
      };
      typed.boundariesFor(["priced", "nameless"]);
      return [
        {
          model: "nameless",
          provider: "vendor",
          calls: 2,
          tokens: 30,
          firstSeen: "2026-09-02T00:00:00.000Z",
          lastSeen: "2026-09-03T00:00:00.000Z",
          classes: [
            {
              tokenClass: "output",
              calls: 2,
              tokens: 30,
              firstSeen: "2026-09-02T00:00:00.000Z",
              lastSeen: "2026-09-03T00:00:00.000Z",
            },
          ],
        },
        {
          model: "priced",
          provider: null,
          calls: 1,
          tokens: 10,
          firstSeen: "2026-09-02T00:00:00.000Z",
          lastSeen: "2026-09-02T00:00:00.000Z",
          classes: [
            {
              tokenClass: "output",
              calls: 1,
              tokens: 10,
              firstSeen: "2026-09-02T00:00:00.000Z",
              lastSeen: "2026-09-02T00:00:00.000Z",
            },
          ],
        },
      ];
    });

    const out = await readUnpricedModels({ orgId: ORG, since: SINCE, at: AT });

    expect(out).toHaveLength(1);
    expect(out[0]!.model).toBe("nameless");
    expect(out[0]!.fullyUnpriced).toBe(true);
    expect(out[0]!.missingClasses).toEqual(["output"]);
    expect(out[0]!.firstSeen).toEqual(new Date("2026-09-02T00:00:00.000Z"));
    loadSpy.mockRestore();
  });

  // #3281. The frame read used to stop at a volume bound ranked by tokens, so
  // an unpriced model with little usage past it never reached the comparison.
  // The report now walks every page in model-id order.
  it("reports an unpriced model that only the second page of the frame read holds", async () => {
    const loadSpy = vi.spyOn(priceBook, "loadPriceBook").mockResolvedValue([]);
    const row = (model: string, tokens: number) => ({
      model,
      provider: "vendor",
      calls: 1,
      tokens,
      firstSeen: "2026-09-02T00:00:00.000Z",
      lastSeen: "2026-09-02T00:00:00.000Z",
      classes: [
        {
          tokenClass: "output",
          calls: 1,
          tokens,
          firstSeen: "2026-09-02T00:00:00.000Z",
          lastSeen: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    // Page one is full of heavy models, so the loop must ask for page two,
    // where the one light model sits.
    const firstPage = Array.from(
      { length: UNPRICED_MODEL_READ_PAGE_SIZE },
      (_, index) => row(`a-${String(index).padStart(5, "0")}`, 1_000_000),
    );
    const pages: Array<{ afterModel?: string; size: number }> = [];
    readObservedModelsMock.mockImplementation(async (args) => {
      const typed = args as {
        page: { afterModel?: string; size: number };
        boundariesFor: (models: readonly string[]) => readonly Date[];
      };
      pages.push(typed.page);
      const rows =
        typed.page.afterModel === undefined ? firstPage : [row("z-light", 1)];
      typed.boundariesFor(rows.map((r) => r.model));
      return rows;
    });
    try {
      const out = await readUnpricedModels({
        orgId: ORG,
        since: SINCE,
        at: AT,
      });
      expect(pages).toEqual([
        { afterModel: undefined, size: UNPRICED_MODEL_READ_PAGE_SIZE },
        {
          afterModel: firstPage.at(-1)!.model,
          size: UNPRICED_MODEL_READ_PAGE_SIZE,
        },
      ]);
      // Every model is unpriced in an empty book. The report cap keeps the
      // heaviest, but the light model on page two was compared: an
      // organization whose only unpriced model is light still hears about it.
      expect(out).toHaveLength(
        Math.min(
          UNPRICED_MODEL_REPORT_LIMIT,
          UNPRICED_MODEL_READ_PAGE_SIZE + 1,
        ),
      );
      expect(out.every((m) => m.fullyUnpriced)).toBe(true);
      expect(new Set(out.map((m) => m.model)).size).toBe(out.length);
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("reports a light unpriced model past a full page of priced ones", async () => {
    const heavy = Array.from(
      { length: UNPRICED_MODEL_READ_PAGE_SIZE },
      (_, index) => `a-${String(index).padStart(5, "0")}`,
    );
    const loadSpy = vi
      .spyOn(priceBook, "loadPriceBook")
      .mockResolvedValue(heavy.flatMap((m) => fullyPriced(m)));
    const row = (model: string, tokens: number) => ({
      model,
      provider: "vendor",
      calls: 1,
      tokens,
      firstSeen: "2026-09-02T00:00:00.000Z",
      lastSeen: "2026-09-02T00:00:00.000Z",
      classes: [
        {
          tokenClass: "output",
          calls: 1,
          tokens,
          firstSeen: "2026-09-02T00:00:00.000Z",
          lastSeen: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    readObservedModelsMock.mockImplementation(async (args) => {
      const typed = args as { page: { afterModel?: string; size: number } };
      expect(typed.page.size).toBe(UNPRICED_MODEL_READ_PAGE_SIZE);
      return typed.page.afterModel === undefined
        ? heavy.map((m) => row(m, 1_000_000))
        : [row("z-light", 1)];
    });
    try {
      const out = await readUnpricedModels({
        orgId: ORG,
        since: SINCE,
        at: AT,
      });
      expect(out.map((m) => m.model)).toEqual(["z-light"]);
      expect(readObservedModelsMock).toHaveBeenCalledTimes(2);
    } finally {
      loadSpy.mockRestore();
    }
  });

  // #3641. ClickHouse orders a String by its UTF-8 bytes, and JavaScript's
  // `>` orders by UTF-16 code units. An emoji sorts after U+FF5E in the store
  // and before it in JavaScript, so a cursor check written with `>` read a
  // page that did advance as stuck and failed the whole report.
  it("walks pages whose ids cross from the BMP past U+FFFF in store order", async () => {
    const loadSpy = vi.spyOn(priceBook, "loadPriceBook").mockResolvedValue([]);
    const row = (model: string) => ({
      model,
      provider: null,
      calls: 1,
      tokens: 1,
      firstSeen: "2026-09-02T00:00:00.000Z",
      lastSeen: "2026-09-02T00:00:00.000Z",
      classes: [
        {
          tokenClass: "output",
          calls: 1,
          tokens: 1,
          firstSeen: "2026-09-02T00:00:00.000Z",
          lastSeen: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    const fullPage = (prefix: string, last: string) => [
      ...Array.from({ length: UNPRICED_MODEL_READ_PAGE_SIZE - 1 }, (_, i) =>
        row(`${prefix}-${String(i).padStart(5, "0")}`),
      ),
      row(last),
    ];
    const bmp = "m-\uFF5E";
    const astral = "m-\u{1F600}";
    const pages: Array<string | undefined> = [];
    readObservedModelsMock.mockImplementation(async (args) => {
      const { page } = args as { page: { afterModel?: string } };
      pages.push(page.afterModel);
      if (page.afterModel === undefined) return fullPage("a", bmp);
      if (page.afterModel === bmp) return fullPage("m-\uFF5F", astral);
      return [row("z-last")];
    });
    try {
      const out = await readUnpricedModels({
        orgId: ORG,
        since: SINCE,
        at: AT,
      });
      expect(pages).toEqual([undefined, bmp, astral]);
      expect(out).toHaveLength(UNPRICED_MODEL_REPORT_LIMIT);
      expect(new Set(out.map((m) => m.model)).size).toBe(out.length);
    } finally {
      loadSpy.mockRestore();
    }
  });

  it("stops when a page does not move the cursor forward", async () => {
    const loadSpy = vi.spyOn(priceBook, "loadPriceBook").mockResolvedValue([]);
    const stuck = Array.from({ length: UNPRICED_MODEL_READ_PAGE_SIZE }, () => ({
      model: "same",
      provider: null,
      calls: 1,
      tokens: 1,
      firstSeen: "2026-09-02T00:00:00.000Z",
      lastSeen: "2026-09-02T00:00:00.000Z",
      classes: [],
    }));
    readObservedModelsMock.mockImplementation(async () => stuck);
    try {
      await expect(
        readUnpricedModels({ orgId: ORG, since: SINCE, at: AT }),
      ).rejects.toThrow(/did not advance/);
    } finally {
      loadSpy.mockRestore();
    }
  });
});

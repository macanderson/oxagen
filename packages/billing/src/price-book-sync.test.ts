import { describe, expect, it } from "vitest";
import { syncPriceBookFromSources } from "./price-book-sync";
import {
  inCodeCardPrices,
  mergePublishedPrices,
  MODELS_DEV_URL,
  OPENROUTER_MODELS_URL,
  type FetchLike,
} from "./price-sources";
import {
  resolvePriceEntry,
  usdPerMillionToMicros,
  type PriceEntry,
  type PriceEntrySeed,
} from "./price-book";
import { IMAGE_RATE_CARD, VIDEO_RATE_CARD } from "./pricing";

const FROM = new Date("2026-09-17T00:00:00.000Z");
/**
 * Distinct models the in-code card contributes, AFTER the merge collapses a
 * model's bare and gateway-prefixed keys into one row. Lower than
 * `Object.keys(PROVIDER_RATE_CARD).length`, and deliberately derived rather
 * than typed: the card carries `claude-sonnet-5` and
 * `anthropic/claude-sonnet-5` as separate keys for the same model, and the
 * merge must treat them as one so an override binds to both.
 */
const CARD_MODELS = mergePublishedPrices([inCodeCardPrices()]).prices.length;

/** Neither override source is set, whatever this test process's env carries. */
const NO_OVERRIDES = { filePath: "", inline: "" };

/** Records every write the sync makes and answers with a fixed tally. */
function recorder(
  result: { written: number; unchanged: number; retired?: number } = {
    written: 0,
    unchanged: 0,
  },
) {
  const calls: {
    effectiveFrom: Date;
    seeds: readonly PriceEntrySeed[];
    retireAbsent: boolean;
  }[] = [];
  return {
    calls,
    get seeds(): readonly PriceEntrySeed[] {
      return calls[0]?.seeds ?? [];
    },
    write: (args: {
      effectiveFrom: Date;
      seeds: readonly PriceEntrySeed[];
      retireAbsent: boolean;
    }) => {
      calls.push(args);
      return Promise.resolve(result);
    },
  };
}

/** A fetch that answers from a url → body map. */
function fakeFetch(bodies: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(bodies[url] ?? {}),
    });
  };
  return { fetchImpl, calls };
}

/** Every catalog is down. */
const refusingFetch: FetchLike = () =>
  Promise.resolve({
    ok: false,
    status: 503,
    json: () => Promise.reject(new Error("never read")),
  });

function seedFor(
  seeds: readonly PriceEntrySeed[],
  model: string,
  tokenClass: string,
): PriceEntrySeed | undefined {
  return seeds.find((s) => s.model === model && s.tokenClass === tokenClass);
}

describe("syncPriceBookFromSources", () => {
  it("still writes every model the in-code card names when every catalog fails", async () => {
    // The whole point of the change: a third party's outage must not leave the
    // book empty and every run's cost NULL.
    const write = recorder({ written: 120, unchanged: 0 });
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      fetchImpl: refusingFetch,
      write: write.write,
    });

    expect(write.calls).toHaveLength(1);
    expect(write.seeds.length).toBeGreaterThan(0);
    expect(
      seedFor(write.seeds, "claude-sonnet-5", "input_uncached"),
    ).toMatchObject({ microsPerMillion: 2_000_000n, provider: "anthropic" });
    expect(report.models).toBe(CARD_MODELS);
    expect(report.counts.in_code_card).toBe(CARD_MODELS);
    expect(report.failures.map((f) => f.source).sort()).toEqual([
      "models_dev",
      "openrouter",
    ]);
    expect(report.failures.every((f) => f.error.includes("503"))).toBe(true);
    // A model absent because its catalog was down is not a price that ended:
    // the write is told the seeds are NOT the whole book, so nothing retires.
    expect(write.calls[0]!.retireAbsent).toBe(false);
    expect(report.retired).toBe(0);
  });

  // With OpenRouter down and models.dev up, a model OpenRouter owns would
  // fall to models.dev's price and be written as a NEW row from this run's
  // instant — which the resolver then prefers over the still-valid OpenRouter
  // row. Runs during the outage would be priced at the lower catalog's rate
  // and switch back when OpenRouter recovered. So the chain stops at the
  // first failed catalog: the ones below it are held, and named as held.
  it("holds a lower-priority catalog while a higher one is down, so its prices cannot supersede rows the failed one still has in force", async () => {
    const fetchImpl: FetchLike = (url) =>
      Promise.resolve(
        url === OPENROUTER_MODELS_URL
          ? {
              ok: false,
              status: 503,
              json: () => Promise.reject(new Error("never read")),
            }
          : {
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  moonshot: {
                    id: "moonshot",
                    models: {
                      "kimi-k3": {
                        id: "kimi-k3",
                        cost: { input: 9, output: 45 },
                      },
                    },
                  },
                }),
            },
      );
    const write = recorder();
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      fetchImpl,
      write: write.write,
    });

    expect(report.failures.map((f) => f.source)).toEqual(["openrouter"]);
    expect(report.held).toEqual(["models_dev"]);
    expect(report.counts.models_dev).toBe(0);
    // Nothing models.dev priced reached the write; the card still did.
    expect(
      seedFor(write.seeds, "moonshot/kimi-k3", "input_uncached"),
    ).toBeUndefined();
    expect(seedFor(write.seeds, "kimi-k3", "input_uncached")).toBeUndefined();
    expect(
      seedFor(write.seeds, "claude-sonnet-5", "input_uncached"),
    ).toBeDefined();
    expect(write.calls[0]!.retireAbsent).toBe(false);
  });

  it("holds nothing when the failed catalog is the lowest in precedence", async () => {
    const { fetchImpl } = fakeFetch({
      [OPENROUTER_MODELS_URL]: {
        data: [
          {
            id: "moonshot/kimi-k3",
            pricing: { prompt: "0.000002", completion: "0.00001" },
          },
        ],
      },
      [MODELS_DEV_URL]: {},
    });
    const write = recorder();
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      fetchImpl,
      write: write.write,
    });
    expect(report.failures.map((f) => f.source)).toEqual(["models_dev"]);
    expect(report.held).toEqual([]);
    expect(report.counts.openrouter).toBe(1);
  });

  it("vouches for the seeds as complete only when every catalog answered", async () => {
    const { fetchImpl } = fakeFetch({
      [OPENROUTER_MODELS_URL]: {
        data: [
          {
            id: "moonshot/kimi-k3",
            pricing: { prompt: "0.000002", completion: "0.00001" },
          },
        ],
      },
      [MODELS_DEV_URL]: {
        moonshot: {
          id: "moonshot",
          models: {
            "kimi-k3": { id: "kimi-k3", cost: { input: 2, output: 10 } },
          },
        },
      },
    });
    const write = recorder({ written: 0, unchanged: 0, retired: 4 });
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      fetchImpl,
      write: write.write,
    });
    expect(report.failures).toEqual([]);
    // Every source answered, so a row nothing emits is a price that ended.
    expect(write.calls[0]!.retireAbsent).toBe(true);
    expect(report.retired).toBe(4);

    // Offline never asked the catalogs, so it can vouch for nothing.
    const offline = recorder();
    await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      offline: true,
      write: offline.write,
    });
    expect(offline.calls[0]!.retireAbsent).toBe(false);
  });

  it("reads no catalog at all when told to stay offline, and still seeds", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const write = recorder();
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      offline: true,
      fetchImpl,
      write: write.write,
    });

    expect(calls).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.models).toBe(CARD_MODELS);
    expect(write.seeds.length).toBeGreaterThan(0);
    expect(seedFor(write.seeds, "claude-fable-5", "output")).toMatchObject({
      microsPerMillion: 50_000_000n,
    });
  });

  it("prices a model at the operator's rate over the card's and the catalog's", async () => {
    const { fetchImpl } = fakeFetch({
      [OPENROUTER_MODELS_URL]: {
        data: [
          {
            id: "claude-sonnet-5",
            pricing: { prompt: "0.000009", completion: "0.000045" },
          },
          {
            id: "moonshot/kimi-k3",
            pricing: { prompt: "0.000002", completion: "0.00001" },
          },
        ],
      },
      [MODELS_DEV_URL]: {
        anthropic: {
          id: "anthropic",
          models: {
            "claude-sonnet-5": {
              id: "claude-sonnet-5",
              cost: { input: 7, output: 35 },
            },
          },
        },
      },
    });
    const write = recorder();
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: {
        filePath: "",
        inline: JSON.stringify({
          "claude-sonnet-5": {
            provider: "anthropic",
            inputPer1M: 2.4,
            outputPer1M: 12,
          },
        }),
      },
      fetchImpl,
      write: write.write,
    });

    // The operator's rate, not the card's $2 and not the catalog's $9.
    expect(
      seedFor(write.seeds, "claude-sonnet-5", "input_uncached")
        ?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(2.4));
    expect(
      seedFor(write.seeds, "claude-sonnet-5", "output")?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(12));
    // A model only a catalog knows still gets its catalog rate.
    expect(
      seedFor(write.seeds, "moonshot/kimi-k3", "input_uncached")
        ?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(2));

    expect(report.counts).toEqual({
      operator_override: 1,
      // The card keeps every model but the one the operator restated.
      in_code_card: CARD_MODELS - 1,
      openrouter: 1,
      // models.dev only repeated a model two higher sources already priced.
      models_dev: 0,
    });
    expect(report.models).toBe(CARD_MODELS + 1);
    expect(report.failures).toEqual([]);
  });

  it("writes nothing on a dry run but still reports what it found", async () => {
    const { fetchImpl } = fakeFetch({
      [OPENROUTER_MODELS_URL]: {
        data: [
          {
            id: "moonshot/kimi-k3",
            pricing: { prompt: "0.000002", completion: "0.00001" },
          },
        ],
      },
      // models.dev answers with a body that prices nothing, which is a failure.
      [MODELS_DEV_URL]: {},
    });
    const write = recorder({ written: 99, unchanged: 99 });
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      dryRun: true,
      fetchImpl,
      write: write.write,
    });

    expect(write.calls).toEqual([]);
    expect(report.written).toBe(0);
    expect(report.unchanged).toBe(0);
    expect(report.models).toBe(CARD_MODELS + 1);
    expect(report.counts.openrouter).toBe(1);
    expect(report.failures.map((f) => f.source)).toEqual(["models_dev"]);
    expect(report.failures[0]!.error).toContain("carried no usable prices");
    // A dry run still hands back the book it would have written.
    expect(
      seedFor(report.seeds, "moonshot/kimi-k3", "input_uncached")
        ?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(2));
  });

  it("seeds the media the card prices although no catalog publishes any", async () => {
    const write = recorder();
    await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      offline: true,
      write: write.write,
    });

    const images = write.seeds.filter((s) => s.tokenClass === "image");
    const videos = write.seeds.filter((s) => s.tokenClass === "video_second");
    expect(images).toHaveLength(Object.keys(IMAGE_RATE_CARD).length);
    expect(videos).toHaveLength(Object.keys(VIDEO_RATE_CARD).length);
    expect(seedFor(write.seeds, "openai/gpt-image-1", "image")).toMatchObject({
      provider: "openai",
      unit: "image",
      microsPerMillion: 40_000_000_000n,
      effectiveFrom: FROM,
      effectiveTo: null,
    });
    expect(
      seedFor(write.seeds, "google/veo-3.0", "video_second"),
    ).toMatchObject({ provider: "google", unit: "second" });
  });

  it("reports the tally the writer actually returned", async () => {
    const write = recorder({ written: 7, unchanged: 331 });
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      overrides: NO_OVERRIDES,
      offline: true,
      write: write.write,
    });
    expect(report.written).toBe(7);
    expect(report.unchanged).toBe(331);
    expect(write.calls[0]!.effectiveFrom).toBe(FROM);
    expect(report.seeds).toEqual(write.seeds);
  });

  it("refuses to run at all on an override the operator mistyped", async () => {
    const write = recorder();
    await expect(
      syncPriceBookFromSources({
        effectiveFrom: FROM,
        overrides: { filePath: "", inline: "{ not json" },
        offline: true,
        write: write.write,
      }),
    ).rejects.toThrow("OXAGEN_PRICE_OVERRIDES");
    expect(write.calls).toEqual([]);
  });

  // An operator override on a bare id does not reach the gateway-prefixed twin
  // the in-code card also carries (`anthropic/claude-sonnet-5`), so a frame
  it("prices the gateway form of an overridden model at the operator's rate", async () => {
    // The regression this guards: the card carries `claude-sonnet-5` and
    // `anthropic/claude-sonnet-5` as separate keys. Keyed on the model id
    // alone, an override of the bare id left the gateway row at the card's
    // price — and `resolvePriceEntry` prefers the longer `anthropic/…` match
    // for a gateway-form id, so every gateway call billed at list price and
    // the negotiated rate applied to nothing, silently.
    const write = recorder();
    const report = await syncPriceBookFromSources({
      effectiveFrom: FROM,
      offline: true,
      write: write.write,
      overrides: {
        inline: JSON.stringify({
          "claude-sonnet-5": { inputPer1M: 1, outputPer1M: 5 },
        }),
      },
    });

    // The card's gateway-prefixed twin must not have been written at all.
    expect(
      seedFor(write.seeds, "anthropic/claude-sonnet-5", "input_uncached"),
    ).toBeUndefined();
    expect(report.counts.operator_override).toBe(1);

    // And the one surviving row prices both spellings the model arrives under.
    const book: PriceEntry[] = write.seeds
      .filter((s) => s.tokenClass === "input_uncached")
      .map((s, i) => ({
        id: `entry-${i}`,
        orgId: null,
        provider: s.provider,
        model: s.model,
        modelAliases: s.modelAliases,
        region: s.region,
        tokenClass: s.tokenClass,
        unit: s.unit,
        currency: s.currency,
        microsPerMillion: s.microsPerMillion,
        effectiveFrom: s.effectiveFrom,
        effectiveTo: s.effectiveTo,
        source: "list" as const,
      }));
    for (const modelId of ["claude-sonnet-5", "anthropic/claude-sonnet-5"]) {
      const entry = resolvePriceEntry(book, {
        orgId: "11111111-1111-1111-1111-111111111111",
        modelId,
        tokenClass: "input_uncached",
        at: new Date(FROM.getTime() + 1_000),
      });
      expect(entry?.microsPerMillion).toBe(usdPerMillionToMicros(1));
    }
  });
});

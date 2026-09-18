import { describe, expect, it } from "vitest";
import {
  deriveCacheWrite1h,
  fetchPublishedPrices,
  inCodeCardPrices,
  mergePublishedPrices,
  MODELS_DEV_URL,
  OPENROUTER_MODELS_URL,
  parseModelsDevCatalog,
  parseOpenRouterCatalog,
  seedsFromPublishedPrices,
  type FetchLike,
  type PublishedModelPrice,
} from "./price-sources";
import { usdPerMillionToMicros } from "./price-book";
import { PROVIDER_RATE_CARD, type RateCard } from "./pricing";

const FROM = new Date("2026-09-01T00:00:00.000Z");

function published(
  overrides: Partial<PublishedModelPrice> & Pick<PublishedModelPrice, "model">,
): PublishedModelPrice {
  return {
    aliases: [],
    provider: "anthropic",
    inputPer1M: 3,
    outputPer1M: 15,
    cachedInputPer1M: null,
    cacheWrite5mPer1M: null,
    cacheWrite1hPer1M: null,
    reasoningPer1M: null,
    source: "in_code_card",
    ...overrides,
  };
}

/** A fetch that answers from a url → body map and refuses anything else. */
function fakeFetch(
  bodies: Record<string, unknown>,
  calls: string[] = [],
): FetchLike {
  return (url) => {
    calls.push(url);
    const body = bodies[url];
    if (body === undefined)
      return Promise.reject(new Error(`no fixture for ${url}`));
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
  };
}

describe("deriveCacheWrite1h", () => {
  it("says nothing about a one-hour tier when the five-minute rate is unknown", () => {
    expect(deriveCacheWrite1h(3, null)).toBe(null);
    expect(deriveCacheWrite1h(0, null)).toBe(null);
  });

  it("leaves a write with no premium over fresh input alone", () => {
    // OpenAI's automatic caching: a write bills at the input rate, so there is
    // no provider write tier to scale up to an hour.
    expect(deriveCacheWrite1h(2.5, 2.5)).toBe(2.5);
    expect(deriveCacheWrite1h(2.5, 1)).toBe(1);
  });

  it("scales a premium write by two-over-one-and-a-quarter", () => {
    // Anthropic Sonnet: $3 input, $3.75 five-minute write, so the hour tier is
    // 2x input = $6.
    expect(deriveCacheWrite1h(3, 3.75)).toBeCloseTo(6, 10);
    expect(deriveCacheWrite1h(15, 18.75)).toBeCloseTo(30, 10);
  });
});

describe("inCodeCardPrices", () => {
  it("publishes every model the rate card names", () => {
    const prices = inCodeCardPrices();
    expect(prices).toHaveLength(Object.keys(PROVIDER_RATE_CARD).length);
    expect(prices.map((p) => p.model).sort()).toEqual(
      Object.keys(PROVIDER_RATE_CARD).sort(),
    );
    expect(prices.every((p) => p.source === "in_code_card")).toBe(true);
  });

  it("gives a gateway-prefixed id its bare form as an alias and carries the provider through", () => {
    const card: RateCard = {
      "anthropic/claude-sonnet-5": {
        provider: "anthropic",
        inputPer1M: 3,
        outputPer1M: 15,
        cachedInputPer1M: 0.3,
        cacheWritePer1M: 3.75,
      },
      "gpt-4o": {
        provider: "openai",
        inputPer1M: 2.5,
        outputPer1M: 10,
        cachedInputPer1M: 1.25,
        cacheWritePer1M: 2.5,
      },
    };
    const card_prices = inCodeCardPrices(card);
    const sonnet = card_prices[0]!;
    const gpt = card_prices[1]!;
    expect(sonnet).toEqual({
      model: "anthropic/claude-sonnet-5",
      aliases: ["claude-sonnet-5"],
      provider: "anthropic",
      inputPer1M: 3,
      outputPer1M: 15,
      cachedInputPer1M: 0.3,
      cacheWrite5mPer1M: 3.75,
      cacheWrite1hPer1M: 6,
      reasoningPer1M: 15,
      source: "in_code_card",
    });
    // A bare id has no prefix to strip, so it carries no alias — and an
    // OpenAI-style write with no premium keeps its own rate at the hour tier.
    expect(gpt.aliases).toEqual([]);
    expect(gpt.provider).toBe("openai");
    expect(gpt.cacheWrite1hPer1M).toBe(2.5);
  });
});

describe("parseOpenRouterCatalog", () => {
  const row = {
    id: "anthropic/claude-sonnet-5",
    canonical_slug: "anthropic/claude-sonnet-5-20260901",
    name: "Claude Sonnet 5",
    context_length: 200_000,
    architecture: { modality: "text->text" },
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
      request: "0",
      image: "0",
    },
  };

  it("scales per-token USD strings up to USD per million tokens", () => {
    const price = parseOpenRouterCatalog({ data: [row] })[0]!;
    expect(price.inputPer1M).toBe(3);
    expect(price.outputPer1M).toBe(15);
    expect(price.cachedInputPer1M).toBe(0.3);
    expect(price.cacheWrite5mPer1M).toBe(3.75);
    expect(price.cacheWrite1hPer1M).toBeCloseTo(6, 10);
    // No `internal_reasoning` published, so reasoning falls to the output rate.
    expect(price.reasoningPer1M).toBe(15);
    expect(price.provider).toBe("anthropic");
    expect(price.source).toBe("openrouter");
  });

  it("keeps the canonical slug as an alias and never as the model", () => {
    const price = parseOpenRouterCatalog({ data: [row] })[0]!;
    expect(price.model).toBe("anthropic/claude-sonnet-5");
    expect(price.aliases).not.toContain(price.model);
    expect([...price.aliases].sort()).toEqual([
      "anthropic/claude-sonnet-5-20260901",
      "claude-sonnet-5",
      "claude-sonnet-5-20260901",
    ]);
  });

  it("does not repeat a canonical slug that is the id it already names", () => {
    const price = parseOpenRouterCatalog({
      data: [{ ...row, canonical_slug: row.id }],
    })[0]!;
    expect(price.aliases).toEqual(["claude-sonnet-5"]);
  });

  it("skips a row that prices neither input nor output", () => {
    const prices = parseOpenRouterCatalog({
      data: [
        { id: "a/no-prompt", pricing: { completion: "0.000015" } },
        { id: "a/no-completion", pricing: { prompt: "0.000003" } },
        { id: "a/free", pricing: { prompt: "0", completion: "0" } },
      ],
    });
    expect(prices.map((p) => p.model)).toEqual(["a/free"]);
    // A free model is priced at zero, not dropped — zero is a price we apply.
    expect(prices[0]!.inputPer1M).toBe(0);
  });

  it("tolerates fields the catalog grew since this parser was written", () => {
    const prices = parseOpenRouterCatalog({
      data: [
        {
          ...row,
          supported_parameters: ["tools"],
          pricing: { ...row.pricing, web_search: "0.01", audio: "0.002" },
        },
      ],
      totally_new_top_level_key: 1,
    });
    expect(prices).toHaveLength(1);
    expect(prices[0]!.inputPer1M).toBe(3);
  });

  it("answers with no prices rather than throwing on a malformed body", () => {
    expect(parseOpenRouterCatalog({ data: "not an array" })).toEqual([]);
    expect(parseOpenRouterCatalog(null)).toEqual([]);
    expect(parseOpenRouterCatalog("<html>502</html>")).toEqual([]);
    expect(parseOpenRouterCatalog({})).toEqual([]);
  });
});

describe("parseModelsDevCatalog", () => {
  const body = {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          cost: {
            input: 3,
            output: 15,
            cache_read: 0.3,
            cache_write: 3.75,
            extra_future_field: 1,
          },
        },
      },
    },
  };

  it("takes models.dev costs as already-per-million and scales nothing", () => {
    const price = parseModelsDevCatalog(body)[0]!;
    expect(price.inputPer1M).toBe(3);
    expect(price.outputPer1M).toBe(15);
    expect(price.cachedInputPer1M).toBe(0.3);
    expect(price.cacheWrite5mPer1M).toBe(3.75);
    expect(price.cacheWrite1hPer1M).toBeCloseTo(6, 10);
    expect(price.reasoningPer1M).toBe(15);
    expect(price.source).toBe("models_dev");
  });

  it("adds the vendor-prefixed form of the id as an alias", () => {
    const price = parseModelsDevCatalog(body)[0]!;
    expect(price.model).toBe("claude-sonnet-5");
    expect(price.provider).toBe("anthropic");
    expect(price.aliases).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("skips a model that publishes no cost block", () => {
    const prices = parseModelsDevCatalog({
      openai: {
        id: "openai",
        models: {
          "gpt-4o": { id: "gpt-4o", cost: { input: 2.5, output: 10 } },
          "gpt-secret": { id: "gpt-secret" },
          "gpt-half": { id: "gpt-half", cost: { input: 1 } },
        },
      },
    });
    expect(prices.map((p) => p.model)).toEqual(["gpt-4o"]);
  });

  it("answers with no prices rather than throwing on a malformed body", () => {
    expect(parseModelsDevCatalog({ anthropic: { models: "nope" } })).toEqual(
      [],
    );
    expect(parseModelsDevCatalog([1, 2, 3])).toEqual([]);
    expect(parseModelsDevCatalog(null)).toEqual([]);
    expect(parseModelsDevCatalog("<html>502</html>")).toEqual([]);
  });
});

describe("mergePublishedPrices", () => {
  it("lets the first source to name a model keep it outright", () => {
    const override = published({
      model: "claude-sonnet-5",
      inputPer1M: 1,
      outputPer1M: 2,
      source: "operator_override",
    });
    const card = published({
      model: "claude-sonnet-5",
      inputPer1M: 3,
      outputPer1M: 15,
      cachedInputPer1M: 0.3,
      source: "in_code_card",
    });
    const merged = mergePublishedPrices([[override], [card]]);
    expect(merged.prices).toHaveLength(1);
    expect(merged.prices[0]).toBe(override);
    // Not a field-by-field merge: the later source contributes nothing at all,
    // so a total is never half an invoice and half a scrape.
    expect(merged.prices[0]!.cachedInputPer1M).toBe(null);
  });

  it("attributes each model to the source that actually won it", () => {
    const merged = mergePublishedPrices([
      [published({ model: "m-override", source: "operator_override" })],
      [
        published({ model: "m-override", source: "in_code_card" }),
        published({ model: "m-card", source: "in_code_card" }),
      ],
      [
        published({ model: "m-card", source: "openrouter" }),
        published({ model: "m-router", source: "openrouter" }),
      ],
      [published({ model: "m-dev", source: "models_dev" })],
    ]);
    expect(merged.counts).toEqual({
      operator_override: 1,
      in_code_card: 1,
      openrouter: 1,
      models_dev: 1,
    });
    expect([...merged.provenance.entries()].sort()).toEqual([
      ["m-card", "in_code_card"],
      ["m-dev", "models_dev"],
      ["m-override", "operator_override"],
      ["m-router", "openrouter"],
    ]);
  });

  it("counts a model once however often one source repeats it", () => {
    const merged = mergePublishedPrices([
      [
        published({ model: "m-1", source: "openrouter" }),
        published({ model: "m-1", inputPer1M: 99, source: "openrouter" }),
        published({ model: "m-2", source: "openrouter" }),
      ],
    ]);
    expect(merged.prices).toHaveLength(2);
    expect(merged.counts.openrouter).toBe(2);
    expect(merged.prices[0]!.inputPer1M).toBe(3);
  });

  it("returns an empty book and zero counts for no sources at all", () => {
    const merged = mergePublishedPrices([]);
    expect(merged.prices).toEqual([]);
    expect(merged.provenance.size).toBe(0);
    expect(merged.counts).toEqual({
      operator_override: 0,
      in_code_card: 0,
      openrouter: 0,
      models_dev: 0,
    });
  });
});

describe("fetchPublishedPrices", () => {
  const openRouterBody = {
    data: [
      {
        id: "anthropic/claude-sonnet-5",
        pricing: { prompt: "0.000003", completion: "0.000015" },
      },
    ],
  };
  const modelsDevBody = {
    openai: {
      id: "openai",
      models: { "gpt-4o": { id: "gpt-4o", cost: { input: 2.5, output: 10 } } },
    },
  };

  it("reads both catalogs and reports each as a clean result", async () => {
    const results = await fetchPublishedPrices({
      fetchImpl: fakeFetch({
        [OPENROUTER_MODELS_URL]: openRouterBody,
        [MODELS_DEV_URL]: modelsDevBody,
      }),
    });
    expect(results.map((r) => r.source)).toEqual(["openrouter", "models_dev"]);
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results[0]!.prices.map((p) => p.model)).toEqual([
      "anthropic/claude-sonnet-5",
    ]);
    expect(results[1]!.prices.map((p) => p.model)).toEqual(["gpt-4o"]);
  });

  it("turns a refused status into a reported failure, not a throw", async () => {
    const results = await fetchPublishedPrices({
      fetchImpl: () =>
        Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.reject(new Error("never read")),
        }),
    });
    expect(results.every((r) => r.prices.length === 0)).toBe(true);
    expect(results[0]!.error).toContain("503");
    expect(results[0]!.error).toContain(OPENROUTER_MODELS_URL);
    expect(results[1]!.error).toContain("503");
  });

  it("turns a body that will not decode into a reported failure", async () => {
    const results = await fetchPublishedPrices({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("Unexpected token < in JSON")),
        }),
    });
    expect(results.map((r) => r.error)).toEqual([
      "Unexpected token < in JSON",
      "Unexpected token < in JSON",
    ]);
  });

  it("reports a catalog that answered but carried no usable prices", async () => {
    const results = await fetchPublishedPrices({
      fetchImpl: fakeFetch({
        [OPENROUTER_MODELS_URL]: { data: [] },
        [MODELS_DEV_URL]: modelsDevBody,
      }),
    });
    expect(results[0]!.error).toContain("carried no usable prices");
    expect(results[0]!.prices).toEqual([]);
    expect(results[1]!.error).toBe(null);
  });

  it("reads only the catalogs it was asked for", async () => {
    const calls: string[] = [];
    const results = await fetchPublishedPrices({
      sources: ["models_dev"],
      fetchImpl: fakeFetch({ [MODELS_DEV_URL]: modelsDevBody }, calls),
    });
    expect(calls).toEqual([MODELS_DEV_URL]);
    expect(results.map((r) => r.source)).toEqual(["models_dev"]);
  });

  it("reads nothing at all when asked for no catalogs", async () => {
    const calls: string[] = [];
    const results = await fetchPublishedPrices({
      sources: [],
      fetchImpl: fakeFetch({}, calls),
    });
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("seedsFromPublishedPrices", () => {
  it("writes one row per class the price actually states", () => {
    const rows = seedsFromPublishedPrices(
      [
        published({
          model: "claude-sonnet-5",
          aliases: ["anthropic/claude-sonnet-5"],
          inputPer1M: 3,
          outputPer1M: 15,
          cachedInputPer1M: 0.3,
          cacheWrite5mPer1M: 3.75,
          cacheWrite1hPer1M: 6,
          reasoningPer1M: 15,
        }),
      ],
      FROM,
    );
    expect(rows.map((r) => [r.tokenClass, r.microsPerMillion])).toEqual([
      ["input_uncached", 3_000_000n],
      ["cache_read", 300_000n],
      ["cache_write_5m", 3_750_000n],
      ["cache_write_1h", 6_000_000n],
      ["output", 15_000_000n],
      ["reasoning", 15_000_000n],
    ]);
    expect(rows[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      modelAliases: ["anthropic/claude-sonnet-5"],
      region: null,
      unit: "token",
      currency: "USD",
      effectiveFrom: FROM,
      effectiveTo: null,
    });
  });

  it("writes no row at all for a class the source left null", () => {
    // The load-bearing invariant: an absent price must never become a zero
    // price, or a frame that uses that class silently costs nothing.
    const rows = seedsFromPublishedPrices(
      [
        published({
          model: "gpt-4o",
          inputPer1M: 2.5,
          outputPer1M: 10,
          cachedInputPer1M: null,
          cacheWrite5mPer1M: null,
          cacheWrite1hPer1M: null,
          reasoningPer1M: null,
        }),
      ],
      FROM,
    );
    expect(rows.map((r) => r.tokenClass)).toEqual(["input_uncached", "output"]);
    expect(rows.some((r) => r.microsPerMillion === 0n)).toBe(false);
  });

  it("still writes a row for a class a source prices at zero", () => {
    const rows = seedsFromPublishedPrices(
      [published({ model: "free-1", inputPer1M: 0, outputPer1M: 0 })],
      FROM,
    );
    expect(rows.map((r) => [r.tokenClass, r.microsPerMillion])).toEqual([
      ["input_uncached", 0n],
      ["output", 0n],
    ]);
  });

  it("converts every figure exactly as the price book converts it", () => {
    const rows = seedsFromPublishedPrices(
      [published({ model: "m-1", inputPer1M: 18.75, outputPer1M: 0.075 })],
      FROM,
    );
    expect(rows[0]!.microsPerMillion).toBe(usdPerMillionToMicros(18.75));
    expect(rows[1]!.microsPerMillion).toBe(usdPerMillionToMicros(0.075));
  });

  it("writes nothing for an empty set of prices", () => {
    expect(seedsFromPublishedPrices([], FROM)).toEqual([]);
  });
});

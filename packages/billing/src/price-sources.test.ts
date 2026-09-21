import { describe, expect, it } from "vitest";
// The identity test moved to its own module so the resolver in `price-book`
// can use the same one without the two files importing each other.
import { isSameModelIdentity } from "./model-identity";
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
  type PriceSourceId,
  type PublishedModelPrice,
} from "./price-sources";
import {
  resolvePriceEntry,
  usdPerMillionToMicros,
  type PriceEntry,
} from "./price-book";
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
  it("leaves an unknown provider unpriced even when its five-minute write has a premium", () => {
    expect(deriveCacheWrite1h("other", 3, 3.75)).toBeNull();
    expect(deriveCacheWrite1h("openai", 2.5, 2.5)).toBeNull();
    expect(deriveCacheWrite1h("anthropic", 3, null)).toBeNull();
  });
  it("uses the documented Anthropic base-input multiplier", () => {
    expect(deriveCacheWrite1h("anthropic", 3, 3.75)).toBe(6);
    expect(deriveCacheWrite1h("anthropic", 15, 18.75)).toBe(30);
    expect(deriveCacheWrite1h("anthropic", 0, 0)).toBe(0);
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
    // A five-minute rate does not establish an OpenAI one-hour cache tier.
    expect(gpt.aliases).toEqual([]);
    expect(gpt.provider).toBe("openai");
    expect(gpt.cacheWrite1hPer1M).toBeNull();
  });

  it("aliases a hyphenated Anthropic release to its dotted and gateway forms", () => {
    // Traffic arrives as anthropic/claude-haiku-4.5 (and claude-sonnet-4.6);
    // the card keys those releases as claude-haiku-4-5 / claude-sonnet-4-6.
    // isSameModelIdentity will not bridge the spellings, so the alias is the
    // only way the in-code fallback prices a catalog-down cold start.
    const card: RateCard = {
      "claude-haiku-4-5": {
        provider: "anthropic",
        inputPer1M: 1,
        outputPer1M: 5,
        cachedInputPer1M: 0.1,
        cacheWritePer1M: 1.25,
      },
      "claude-sonnet-4-6": {
        provider: "anthropic",
        inputPer1M: 3,
        outputPer1M: 15,
        cachedInputPer1M: 0.3,
        cacheWritePer1M: 3.75,
      },
      "claude-opus-4-8": {
        provider: "anthropic",
        inputPer1M: 15,
        outputPer1M: 75,
        cachedInputPer1M: 1.5,
        cacheWritePer1M: 18.75,
      },
      // A snapshot-style hyphenated id must NOT invent a dotted alias.
      "gpt-4-0613": {
        provider: "openai",
        inputPer1M: 30,
        outputPer1M: 60,
        cachedInputPer1M: 15,
        cacheWritePer1M: 30,
      },
    };
    const byModel = new Map(inCodeCardPrices(card).map((p) => [p.model, p]));
    expect(byModel.get("claude-haiku-4-5")!.aliases.sort()).toEqual([
      "anthropic/claude-haiku-4.5",
      "claude-haiku-4.5",
    ]);
    expect(byModel.get("claude-sonnet-4-6")!.aliases.sort()).toEqual([
      "anthropic/claude-sonnet-4.6",
      "claude-sonnet-4.6",
    ]);
    expect(byModel.get("claude-opus-4-8")!.aliases.sort()).toEqual([
      "anthropic/claude-opus-4.8",
      "claude-opus-4.8",
    ]);
    expect(byModel.get("gpt-4-0613")!.aliases).toEqual([]);
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

  it("does not invent a one-hour rate for another provider with the same cache-write premium", () => {
    const price = parseOpenRouterCatalog({
      data: [{ ...row, id: "other/model", canonical_slug: "other/model" }],
    })[0]!;
    expect(price.cacheWrite5mPer1M).toBe(3.75);
    expect(price.cacheWrite1hPer1M).toBeNull();
  });

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

  it("requires a known provider policy when reading a models.dev cache-write premium", () => {
    const price = parseModelsDevCatalog({
      other: {
        id: "other",
        models: {
          model: { cost: { input: 3, output: 15, cache_write: 3.75 } },
        },
      },
    })[0]!;
    expect(price.cacheWrite5mPer1M).toBe(3.75);
    expect(price.cacheWrite1hPer1M).toBeNull();
  });

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

  // The resolver takes the LONGEST name that prefixes a frame's model id, so
  // an exact-name merge that kept both an override for `claude-sonnet-5` and
  // the card's `claude-sonnet-5-20260901` would let every stamped frame pick
  // the longer list row and bypass the negotiated rate, silently.
  it("drops a lower source's model whose name falls inside a name a higher source claimed", () => {
    const family = published({
      model: "claude-sonnet-5",
      inputPer1M: 1,
      outputPer1M: 2,
      source: "operator_override",
    });
    const card = published({
      model: "claude-sonnet-5-20260901",
      inputPer1M: 3,
      outputPer1M: 15,
      source: "in_code_card",
    });
    const other = published({
      model: "claude-fable-5",
      inputPer1M: 15,
      outputPer1M: 75,
      source: "in_code_card",
    });
    const merged = mergePublishedPrices([[family], [card, other]]);
    expect(merged.prices.map((p) => p.model)).toEqual([
      "claude-sonnet-5",
      "claude-fable-5",
    ]);
    expect(merged.counts).toMatchObject({
      operator_override: 1,
      in_code_card: 1,
    });

    // And the family row is what a specific frame then resolves to.
    const book: PriceEntry[] = seedsFromPublishedPrices(
      merged.prices,
      new Date("2026-09-01T00:00:00.000Z"),
    ).map((s, i) => ({ ...s, id: `e-${i}`, orgId: null, source: "list" }));
    expect(
      resolvePriceEntry(book, {
        orgId: "00000000-0000-4000-8000-000000000001",
        modelId: "claude-sonnet-5-20260901",
        tokenClass: "input_uncached",
        at: new Date("2026-09-02T00:00:00.000Z"),
      })?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(1));
  });

  // The reverse of the family-over-stamp case above: the higher source names
  // the stamped id and the lower source names the bare family. One-way
  // identity (`isSameModelIdentity(lower, higher)`) returns false because
  // `gpt-4` does not start with `gpt-4-0613`, so both rows survived and
  // stamped frames took the override while bare frames kept the card rate.
  it("drops a lower source's bare family when a higher source claimed its stamped id", () => {
    const stamped = published({
      model: "gpt-4-0613",
      provider: "openai",
      inputPer1M: 1,
      outputPer1M: 2,
      source: "operator_override",
    });
    const family = published({
      model: "gpt-4",
      provider: "openai",
      inputPer1M: 30,
      outputPer1M: 60,
      source: "in_code_card",
    });
    const other = published({
      model: "gpt-4o",
      provider: "openai",
      inputPer1M: 2.5,
      outputPer1M: 10,
      source: "in_code_card",
    });
    const merged = mergePublishedPrices([[stamped], [family, other]]);
    expect(merged.prices.map((p) => p.model)).toEqual(["gpt-4-0613", "gpt-4o"]);
    expect(merged.counts).toMatchObject({
      operator_override: 1,
      in_code_card: 1,
    });

    const book: PriceEntry[] = seedsFromPublishedPrices(
      merged.prices,
      new Date("2026-09-01T00:00:00.000Z"),
    ).map((s, i) => ({ ...s, id: `e-${i}`, orgId: null, source: "list" }));
    // Stamped frames take the override. Bare frames no longer find the card's
    // family row, so they cannot keep a different rate for the same identity;
    // the resolver matches a frame against an entry name as
    // isSameModelIdentity(frame, entry), which a stamped entry does not satisfy
    // for a bare frame, so the call is unpriced rather than silently mispriced.
    expect(
      resolvePriceEntry(book, {
        orgId: "00000000-0000-4000-8000-000000000001",
        modelId: "gpt-4-0613",
        tokenClass: "input_uncached",
        at: new Date("2026-09-02T00:00:00.000Z"),
      })?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(1));
    expect(
      resolvePriceEntry(book, {
        orgId: "00000000-0000-4000-8000-000000000001",
        modelId: "gpt-4",
        tokenClass: "input_uncached",
        at: new Date("2026-09-02T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("prices dotted gateway Claude releases from the in-code card alone", () => {
    // Catalogs down, cold start: only the card seeds the book. Gateway traffic
    // reports anthropic/claude-haiku-4.5 and anthropic/claude-sonnet-4.6; the
    // card keys those as hyphenated releases. Without the dotted aliases the
    // numeric-release identity rule leaves both unpriced.
    const merged = mergePublishedPrices([[...inCodeCardPrices()]]);
    const book: PriceEntry[] = seedsFromPublishedPrices(
      merged.prices,
      new Date("2026-09-01T00:00:00.000Z"),
    ).map((s, i) => ({ ...s, id: `e-${i}`, orgId: null, source: "list" }));
    const at = new Date("2026-09-02T00:00:00.000Z");
    const orgId = "00000000-0000-4000-8000-000000000001";
    expect(
      resolvePriceEntry(book, {
        orgId,
        modelId: "anthropic/claude-haiku-4.5",
        tokenClass: "input_uncached",
        at,
      })?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(1));
    expect(
      resolvePriceEntry(book, {
        orgId,
        modelId: "anthropic/claude-sonnet-4.6",
        tokenClass: "input_uncached",
        at,
      })?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(3));
    // The shorter family row must still not claim a distinct release via
    // identity alone: a bare dotted id without the alias path is covered by
    // the hyphenated row's explicit alias, not by anthropic/claude-haiku-4.
    expect(
      isSameModelIdentity(
        "anthropic/claude-haiku-4.5",
        "anthropic/claude-haiku-4",
      ),
    ).toBe(false);
  });

  // The other half of that rule: leading characters are not an identity.
  // `gpt-4` and `gpt-4o` are different models at different prices, so an
  // override for the first must leave the second, and `gpt-4o-mini`, priced
  // from their own sources. Dropping them dropped the only rows that could
  // price them; once retirement closed the rows they had, the resolver's
  // longest-prefix match handed every `gpt-4o` call to the `gpt-4` override
  // and billed a frontier model at the older model's rate.
  it("leaves a lower source's model that merely shares leading characters", () => {
    const override = published({
      model: "gpt-4",
      provider: "openai",
      inputPer1M: 1,
      outputPer1M: 2,
      source: "operator_override",
    });
    const merged = mergePublishedPrices([
      [override],
      [
        published({
          model: "gpt-4o",
          provider: "openai",
          inputPer1M: 2.5,
          outputPer1M: 10,
        }),
        published({
          model: "gpt-4o-mini",
          provider: "openai",
          inputPer1M: 0.15,
          outputPer1M: 0.6,
        }),
        // `turbo` is a separately priced product, not a snapshot of `gpt-4`,
        // so the override does not reach it either. Only a point-in-time stamp
        // inherits.
        published({
          model: "gpt-4-turbo",
          provider: "openai",
          inputPer1M: 10,
          outputPer1M: 30,
        }),
        // A date stamp IS the same product at a moment, so this one is
        // displaced, which is what the override is for.
        published({
          model: "gpt-4-0613",
          provider: "openai",
          inputPer1M: 30,
          outputPer1M: 60,
        }),
      ],
    ]);
    expect(merged.prices.map((p) => p.model)).toEqual([
      "gpt-4",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
    ]);
    expect(merged.counts).toMatchObject({
      operator_override: 1,
      in_code_card: 3,
    });

    // And each survivor then prices its own calls, at its own rate.
    const book: PriceEntry[] = seedsFromPublishedPrices(
      merged.prices,
      new Date("2026-09-01T00:00:00.000Z"),
    ).map((seed, i) => ({
      ...seed,
      id: `e-${i}`,
      orgId: null,
      source: "list" as const,
    }));
    const priced = (modelId: string) =>
      resolvePriceEntry(book, {
        orgId: "00000000-0000-4000-8000-000000000001",
        modelId,
        tokenClass: "input_uncached",
        at: new Date("2026-09-02T00:00:00.000Z"),
      })?.microsPerMillion;
    expect(priced("gpt-4-0613")).toBe(usdPerMillionToMicros(1));
    expect(priced("gpt-4o-2026-08-01")).toBe(usdPerMillionToMicros(2.5));
    expect(priced("gpt-4o-mini-2026-08-01")).toBe(usdPerMillionToMicros(0.15));
    // The regression this pins: the mini row survives AND wins its own calls,
    // instead of the `gpt-4o`-shaped override's rate reaching it.
    expect(priced("gpt-4o-mini")).toBe(usdPerMillionToMicros(0.15));
    expect(priced("gpt-4-turbo")).toBe(usdPerMillionToMicros(10));
  });

  // The fourth round's finding: a numeric release is a separately priced
  // product, not a snapshot of the one whose name it extends. The card prices
  // `gpt-5` at $1.25/$10, `gpt-5.2` at $1.75/$14 and `gpt-5.5` at $5/$30, so an
  // override for `gpt-5` that displaced the other two rows left nothing that
  // could price them, and every `gpt-5.2` and `gpt-5.5` call then resolved to
  // the negotiated `gpt-5` rate.
  it("leaves a lower source's separately priced numeric release beneath an override", () => {
    const override = published({
      model: "gpt-5",
      provider: "openai",
      inputPer1M: 1,
      outputPer1M: 8,
      source: "operator_override",
    });
    const merged = mergePublishedPrices([
      [override],
      [
        published({
          model: "gpt-5.2",
          provider: "openai",
          inputPer1M: 1.75,
          outputPer1M: 14,
        }),
        published({
          model: "gpt-5.5",
          provider: "openai",
          inputPer1M: 5,
          outputPer1M: 30,
        }),
        // A stamp of the overridden product still gives way, which is the half
        // of the rule the override is for.
        published({
          model: "gpt-5-2026-08-01",
          provider: "openai",
          inputPer1M: 1.25,
          outputPer1M: 10,
        }),
      ],
    ]);
    expect(merged.prices.map((p) => p.model)).toEqual([
      "gpt-5",
      "gpt-5.2",
      "gpt-5.5",
    ]);

    const book: PriceEntry[] = seedsFromPublishedPrices(
      merged.prices,
      new Date("2026-09-01T00:00:00.000Z"),
    ).map((seed, i) => ({
      ...seed,
      id: `e-${i}`,
      orgId: null,
      source: "list" as const,
    }));
    const priced = (modelId: string) =>
      resolvePriceEntry(book, {
        orgId: "00000000-0000-4000-8000-000000000001",
        modelId,
        tokenClass: "input_uncached",
        at: new Date("2026-09-02T00:00:00.000Z"),
      })?.microsPerMillion;
    expect(priced("gpt-5.2")).toBe(usdPerMillionToMicros(1.75));
    expect(priced("gpt-5.5")).toBe(usdPerMillionToMicros(5));
    expect(priced("gpt-5-2026-08-01")).toBe(usdPerMillionToMicros(1));
  });

  // The displacement half of the same finding: an installation override for
  // `gpt-4o` used to discard the catalog's `gpt-4o-mini` row, because `-` is a
  // separator. With the mini row gone, every mini call then resolved to the
  // override and billed at roughly seventeen times its published rate.
  it("leaves a lower source's separately priced product beneath an override", () => {
    const override = published({
      model: "gpt-4o",
      provider: "openai",
      inputPer1M: 2.5,
      outputPer1M: 10,
      source: "operator_override",
    });
    const merged = mergePublishedPrices([
      [override],
      [
        published({
          model: "gpt-4o-mini",
          provider: "openai",
          inputPer1M: 0.15,
          outputPer1M: 0.6,
        }),
        // A dated release of the overridden model IS displaced by it.
        published({
          model: "gpt-4o-2026-08-01",
          provider: "openai",
          inputPer1M: 5,
          outputPer1M: 20,
        }),
      ],
    ]);
    expect(merged.prices.map((p) => p.model)).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    expect(merged.counts).toMatchObject({
      operator_override: 1,
      in_code_card: 1,
    });

    const book: PriceEntry[] = seedsFromPublishedPrices(
      merged.prices,
      new Date("2026-09-01T00:00:00.000Z"),
    ).map((seed, i) => ({
      ...seed,
      id: `e-${i}`,
      orgId: null,
      source: "list" as const,
    }));
    const priced = (modelId: string) =>
      resolvePriceEntry(book, {
        orgId: "00000000-0000-4000-8000-000000000001",
        modelId,
        tokenClass: "input_uncached",
        at: new Date("2026-09-02T00:00:00.000Z"),
      })?.microsPerMillion;
    expect(priced("gpt-4o-mini")).toBe(usdPerMillionToMicros(0.15));
    expect(priced("gpt-4o")).toBe(usdPerMillionToMicros(2.5));
    expect(priced("gpt-4o-2026-08-01")).toBe(usdPerMillionToMicros(2.5));
  });

  it("keeps a family and a specific model when the SAME source published both", () => {
    const merged = mergePublishedPrices([
      [
        published({ model: "claude-sonnet", source: "in_code_card" }),
        published({ model: "claude-sonnet-5", source: "in_code_card" }),
      ],
    ]);
    expect(merged.prices).toHaveLength(2);
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

describe("seedsFromPublishedPrices, provenance", () => {
  it("stamps an operator override as such, and everything else as list", () => {
    const at = new Date("2026-09-18T16:00:00.000Z");
    const price = (source: PriceSourceId): PublishedModelPrice => ({
      model: "m",
      aliases: [],
      provider: "p",
      inputPer1M: 1,
      outputPer1M: 2,
      cachedInputPer1M: null,
      cacheWrite5mPer1M: null,
      cacheWrite1hPer1M: null,
      reasoningPer1M: null,
      source,
    });
    const sources = seedsFromPublishedPrices(
      [price("operator_override"), price("openrouter")],
      at,
    ).map((s) => s.source);
    expect(sources.filter((s) => s === "override")).toHaveLength(2);
    expect(sources.filter((s) => s === "list")).toHaveLength(2);
  });
});

// The comparison the merge displaces on. Inheritance is restricted to what is
// actually stated: an explicit alias, or a stamp that says WHEN a product was
// snapshot — an ISO date, the compact form, a four-digit snapshot, `latest`.
// Every other suffix is a distinct identity, including a release number: the
// rate card in `pricing.ts` prices `gpt-5` at $1.25/$10, `gpt-5.2` at
// $1.75/$14 and `gpt-5.5` at $5/$30, and `grok-4` at $3/$15 above both
// `grok-4.5` ($2/$6) and `grok-4.3` ($1.25/$2.50). Punctuation cannot tell a
// release from a snapshot, and the safe direction is to leave a model unpriced
// rather than bill it another product's rate.
describe("isSameModelIdentity", () => {
  it("inherits a date stamp, a snapshot or `latest`", () => {
    expect(isSameModelIdentity("gpt-4", "gpt-4")).toBe(true);
    expect(isSameModelIdentity("gpt-4o-2026-08-01", "gpt-4o")).toBe(true);
    expect(isSameModelIdentity("gpt-4-0613", "gpt-4")).toBe(true);
    expect(
      isSameModelIdentity("claude-sonnet-5-20260901", "claude-sonnet-5"),
    ).toBe(true);
    expect(
      isSameModelIdentity("claude-sonnet-5-latest", "claude-sonnet-5"),
    ).toBe(true);
  });

  it("keeps a numeric release as a distinct identity", () => {
    // The finding this round exists for. The rate card gives each of these its
    // own row at its own price, so a negotiated `gpt-5` that reached `gpt-5.2`
    // billed a $1.75/$14 product at $1.25/$10, and `gpt-5.5` ($5/$30) at a
    // quarter of its rate.
    expect(isSameModelIdentity("gpt-5.2", "gpt-5")).toBe(false);
    expect(isSameModelIdentity("gpt-5.5", "gpt-5")).toBe(false);
    expect(isSameModelIdentity("gpt-5.5-pro", "gpt-5")).toBe(false);
    // The error runs the other way too: `grok-4` is DEARER than the releases
    // that follow it, so inheriting would have under-billed rather than over.
    expect(isSameModelIdentity("grok-4.5", "grok-4")).toBe(false);
    expect(isSameModelIdentity("grok-4.3", "grok-4")).toBe(false);
    expect(isSameModelIdentity("glm-5.2", "glm")).toBe(false);
    // A dotted-numeric stamp of a numeric release is still that release.
    expect(isSameModelIdentity("gpt-5.2-2026-08-01", "gpt-5")).toBe(false);
    expect(isSameModelIdentity("gpt-5.2-2026-08-01", "gpt-5.2")).toBe(true);
    // The card carries `claude-sonnet` and `claude-sonnet-5` as two rows, so
    // they are two identities whatever their prices happen to be today.
    expect(isSameModelIdentity("claude-sonnet-5", "claude-sonnet")).toBe(false);
    expect(
      isSameModelIdentity("claude-sonnet-5-20260901", "claude-sonnet"),
    ).toBe(false);
    // A bare ordinal is not a point in time either.
    expect(isSameModelIdentity("gemini-1.5-pro-002", "gemini-1.5-pro")).toBe(
      false,
    );
    expect(isSameModelIdentity("claude-opus-4-8", "claude-opus-4")).toBe(false);
  });

  it("keeps a hyphenated product as a distinct identity", () => {
    // Round three: `-` is a separator, so a boundary test let a negotiated
    // `gpt-4o` price `gpt-4o-mini` at a tenth of the rate.
    expect(isSameModelIdentity("gpt-4o-mini", "gpt-4o")).toBe(false);
    expect(isSameModelIdentity("gpt-4o-mini-2026-08-01", "gpt-4o")).toBe(false);
    expect(isSameModelIdentity("gpt-5-nano", "gpt-5")).toBe(false);
    expect(isSameModelIdentity("gemini-1.5-flash", "gemini-1.5")).toBe(false);
    // `turbo` is a product, not a snapshot.
    expect(isSameModelIdentity("gpt-4-turbo", "gpt-4")).toBe(false);
    // A gateway variant is priced on its own, so it does not inherit either.
    expect(
      isSameModelIdentity("claude-sonnet-5:thinking", "claude-sonnet-5"),
    ).toBe(false);
    // Ending at a separator does not let a name own everything beneath it.
    expect(isSameModelIdentity("anthropic/claude-sonnet-5", "anthropic/")).toBe(
      false,
    );
  });

  it("still holds the earlier rounds' cases", () => {
    // Round two: leading characters are not an identity at all.
    expect(isSameModelIdentity("gpt-4o", "gpt-4")).toBe(false);
    expect(isSameModelIdentity("gpt-4o-mini", "gpt-4")).toBe(false);
    expect(isSameModelIdentity("claude-sonnet-50", "claude-sonnet-5")).toBe(
      false,
    );
    // Shorter is never the longer one's identity: the resolver prefers the
    // longer match, so a family row below a specific override bypasses nothing.
    expect(isSameModelIdentity("gpt-4", "gpt-4-turbo")).toBe(false);
    expect(isSameModelIdentity("gpt-4o", "")).toBe(false);
    // Round one: the gateway form binds as an EXPLICIT alias, which is the
    // other relationship that inherits — see the alias tests above.
    expect(
      isSameModelIdentity(
        "anthropic/claude-sonnet-5",
        "anthropic/claude-sonnet-5",
      ),
    ).toBe(true);
  });
});

// The offline case the finding describes: a fresh or offline installation gets
// no catalog response at all, so the in-code card is the entire book. Tightening
// `isSameModelIdentity` to stop a numeric release inheriting implicitly left the
// other half of its own rule undone — the dotted gateway spelling of a
// hyphenated card row had to become an EXPLICIT alias, or it matched nothing and
// the platform's own default fast model went unpriced.
describe("the in-code card alone, with no catalog response", () => {
  const ORG = "00000000-0000-4000-8000-000000000001";
  const EFFECTIVE_FROM = new Date("2026-09-01T00:00:00.000Z");
  const AT = new Date("2026-09-02T00:00:00.000Z");

  /** The book an offline sync writes: the card, merged as its only source. */
  function offlineBook(): PriceEntry[] {
    const merged = mergePublishedPrices([inCodeCardPrices()]);
    return seedsFromPublishedPrices(merged.prices, EFFECTIVE_FROM).map(
      (s, i) => ({ ...s, id: `e-${i}`, orgId: null, source: "list" as const }),
    );
  }

  function priced(book: PriceEntry[], modelId: string) {
    return resolvePriceEntry(book, {
      orgId: ORG,
      modelId,
      tokenClass: "input_uncached",
      at: AT,
    });
  }

  it("prices the dotted gateway spelling of every hyphenated card release", () => {
    const book = offlineBook();
    // The active fast-model default (`@oxagen/ai`'s OXAGEN_LLM_FAST) and the
    // most common traffic there is.
    expect(priced(book, "anthropic/claude-haiku-4.5")?.microsPerMillion).toBe(
      usdPerMillionToMicros(1.0),
    );
    // The spelling `pricing.ts` documents gateway traffic arriving under.
    expect(priced(book, "anthropic/claude-sonnet-4.6")?.microsPerMillion).toBe(
      usdPerMillionToMicros(3.0),
    );
    expect(priced(book, "anthropic/claude-opus-4.8")?.microsPerMillion).toBe(
      usdPerMillionToMicros(15.0),
    );
    // The bare form of each resolves too: a direct caller passes it without a
    // vendor prefix.
    expect(priced(book, "claude-haiku-4.5")?.microsPerMillion).toBe(
      usdPerMillionToMicros(1.0),
    );
    expect(priced(book, "claude-sonnet-4.6")?.microsPerMillion).toBe(
      usdPerMillionToMicros(3.0),
    );
    expect(priced(book, "claude-opus-4.8")?.microsPerMillion).toBe(
      usdPerMillionToMicros(15.0),
    );
    // A stamped snapshot of the dotted release still inherits, as the stamp
    // rule allows.
    expect(
      priced(book, "anthropic/claude-haiku-4.5-20260901")?.microsPerMillion,
    ).toBe(usdPerMillionToMicros(1.0));
  });

  it("derives the dotted alias only for a hyphenated release tail", () => {
    // The derivation is mechanical, so what it must NOT rewrite is the thing to
    // pin: an id whose tail is not a hyphenated digit pair gains no alias, which
    // is why no separately priced pair is joined.
    const aliasesOf = new Map(
      inCodeCardPrices().map((p) => [p.model, p.aliases]),
    );
    /** The dotted aliases the builder derives for an id outside the card. */
    const dottedSpellingOf = (model: string): string[] =>
      inCodeCardPrices({
        [model]: PROVIDER_RATE_CARD["claude-haiku-4"]!,
      })[0]!.aliases.filter((a) => a.includes("."));
    // Both spellings of the gateway form, so the card's row claims the dotted
    // name in the merge instead of leaving a catalog row to be preferred on the
    // resolver's direct pass.
    expect(aliasesOf.get("claude-haiku-4-5")).toEqual([
      "claude-haiku-4.5",
      "anthropic/claude-haiku-4.5",
    ]);
    expect(aliasesOf.get("claude-sonnet-4-6")).toEqual([
      "claude-sonnet-4.6",
      "anthropic/claude-sonnet-4.6",
    ]);
    expect(aliasesOf.get("claude-opus-4-8")).toEqual([
      "claude-opus-4.8",
      "anthropic/claude-opus-4.8",
    ]);
    // Neither a single-segment release nor an already-dotted one derives.
    expect(aliasesOf.get("claude-opus-4")).toEqual([]);
    expect(aliasesOf.get("gpt-5")).toEqual([]);
    expect(aliasesOf.get("gpt-5.2")).toEqual([]);
    expect(aliasesOf.get("gpt-5.5")).toEqual([]);
    expect(aliasesOf.get("grok-4")).toEqual([]);
    expect(aliasesOf.get("grok-4.3")).toEqual([]);
    expect(aliasesOf.get("glm")).toEqual([]);
    expect(aliasesOf.get("glm-5.2")).toEqual([]);
    // A word tail is not a release number.
    expect(aliasesOf.get("gpt-5-mini")).toEqual([]);
    expect(aliasesOf.get("gpt-4o-mini")).toEqual([]);
    // A point-in-time stamp is not a release number: both parts of a release
    // number are one or two digits, so a compact date derives nothing.
    expect(dottedSpellingOf("claude-sonnet-5-20260901")).toEqual([]);
    expect(dottedSpellingOf("gpt-4o-2026-08-01")).toEqual([]);
    expect(dottedSpellingOf("gpt-4-0613")).toEqual([]);
    // A vendor-prefixed key still yields its bare form, and both spellings of
    // the dotted release when it has one.
    expect(aliasesOf.get("anthropic/claude-haiku-4")).toEqual([
      "claude-haiku-4",
    ]);
  });

  it("keeps every separately priced release its own identity", () => {
    const book = offlineBook();
    // Each pair the previous round deliberately split: the row that prices the
    // frame must be the frame's own row, not the family's.
    const pairs: readonly (readonly [string, string, number])[] = [
      ["gpt-5", "gpt-5", 1.25],
      ["gpt-5.2", "gpt-5.2", 1.75],
      ["gpt-5.5", "gpt-5.5", 5.0],
      ["grok-4", "grok-4", 3.0],
      ["grok-4.3", "grok-4.3", 1.25],
      ["grok-4.5", "grok-4.5", 2.0],
      ["glm", "glm", 0.95],
      ["glm-5.2", "glm-5.2", 1.4],
      // Same price today, so the row that matched is the only proof they are
      // still two identities.
      ["claude-opus-4", "claude-opus-4", 15.0],
      ["claude-opus-4-8", "claude-opus-4-8", 15.0],
      ["claude-opus-4.8", "claude-opus-4-8", 15.0],
    ];
    for (const [modelId, expectedRow, usd] of pairs) {
      const entry = priced(book, modelId);
      expect(entry?.model, modelId).toBe(expectedRow);
      expect(entry?.microsPerMillion, modelId).toBe(usdPerMillionToMicros(usd));
    }
  });
});

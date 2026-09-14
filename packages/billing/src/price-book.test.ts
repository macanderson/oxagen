import { describe, expect, it } from "vitest";
import {
  priceEntriesFromRateCards,
  resolvePriceEntry,
  usdPerMillionToMicros,
  usdPerUnitToMicrosPerMillion,
  type PriceEntry,
} from "./price-book";
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

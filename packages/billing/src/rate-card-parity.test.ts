import { describe, it, expect } from "vitest";
import {
  RATE_CARD,
  estimateCostUsd,
} from "./rate-card";
import { providerCostUsd, isRateCardMiss, PROVIDER_RATE_CARD } from "./pricing";

/**
 * The two rate cards, held together.
 *
 * `rate-card.ts` prices a model for the routing policy preview and for
 * `oxagen cost`; `pricing.ts` prices the same model for the credits we
 * actually debit. They are separate files on purpose — the rate card is a pure
 * table the CLI bundles without Stripe — so nothing but this test stops them
 * drifting, and for most of a generation of models nothing did:
 * every family the router gained after `gpt-4o` was missing from the billing
 * card and billed at the Sonnet fallback instead (#1412).
 *
 * A new family therefore fails here until it has a billing row. That is the
 * point: the failure lands on the PR that adds the family, not on a customer's
 * invoice.
 *
 * It drifted a second way, and this test could not see it: the engine's card
 * had no cache-WRITE rate at all, so it priced a cache write as fresh input
 * while the invoice charged the write rate. Every shape below left the write
 * term at zero, so the two cards agreed on a rate neither was exercising
 * (#1411). Two shapes now carry one, and the invariants at the bottom pin the
 * rule the rates follow.
 */

/** Usage shapes that exercise every term the two cards share. */
const SHAPES = [
  { label: "1M in / 1M out", inputTokens: 1_000_000, outputTokens: 1_000_000 },
  { label: "input only", inputTokens: 1_000_000, outputTokens: 0 },
  { label: "output only", inputTokens: 0, outputTokens: 1_000_000 },
  {
    label: "cache-heavy",
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cachedTokens: 800_000,
  },
  { label: "a small real step", inputTokens: 1_500, outputTokens: 40 },
  {
    // The shape that was missing, and the reason #1411 survived this test: with
    // no cache-write term in any shape, both cards agreed on a rate neither was
    // exercising. A priming step is mostly this — the whole system prompt and
    // code-graph context written into the cache in one call.
    label: "a priming step (cache write)",
    inputTokens: 1_000_000,
    outputTokens: 20_000,
    cacheWriteTokens: 900_000,
  },
  {
    // Both halves at once, since they are disjoint subsets of inputTokens and
    // a card that subtracts only one of them still lands on the wrong fresh
    // remainder.
    label: "cache read and write together",
    inputTokens: 1_000_000,
    outputTokens: 50_000,
    cachedTokens: 600_000,
    cacheWriteTokens: 300_000,
  },
] as const;

describe("rate-card parity: engine card vs billing card", () => {
  for (const entry of RATE_CARD) {
    const slug = `${entry.vendor}/${entry.family}`;

    describe(slug, () => {
      it("has a billing row, so it is not billed at the fallback rate", () => {
        // Both shapes reach billing: direct callers pass the bare family, the
        // Vercel AI Gateway passes "creator/model".
        expect(isRateCardMiss(entry.family)).toBe(false);
        expect(isRateCardMiss(slug)).toBe(false);
      });

      for (const shape of SHAPES) {
        it(`prices ${shape.label} identically in both cards`, () => {
          const engine = estimateCostUsd(slug, shape);
          // Nine places, not exact equality: the two functions sum the same
          // terms in a different order, so the last binary digit can differ.
          expect(providerCostUsd({ model: slug, ...shape })).toBeCloseTo(
            engine,
            9,
          );
          expect(
            providerCostUsd({ model: entry.family, ...shape }),
          ).toBeCloseTo(engine, 9);
        });
      }
    });
  }
});

describe("rate-card parity: the prices #1412 measured", () => {
  // The exact table from the issue — what the engine's card says a 1M-in /
  // 1M-out call costs, against what billing charged for it before the rows
  // existed. Every row but the three controls was metered at the Sonnet
  // fallback's $18.00.
  const MEASURED: ReadonlyArray<readonly [string, number]> = [
    ["anthropic/claude-opus-4-8", 90.0],
    ["anthropic/claude-sonnet-5", 18.0],
    ["openai/gpt-4o", 12.5],
    ["openai/gpt-5", 11.25],
    ["openai/gpt-5-mini", 2.25],
    ["openai/o3", 10.0],
    ["zai/glm-5.2", 5.8],
    ["zai/glm-5.2-fast", 13.25],
    ["xai/grok-4.5", 8.0],
    ["deepseek/deepseek-v3.2", 0.7],
    ["google/gemini-3-pro", 14.0],
    // The other direction: sold below cost while the row was missing.
    ["openai/gpt-5.5-pro", 210.0],
  ];

  for (const [model, expectedUsd] of MEASURED) {
    it(`${model} costs $${expectedUsd} for 1M in / 1M out`, () => {
      expect(
        providerCostUsd({
          model,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      ).toBeCloseTo(expectedUsd, 9);
    });
  }
});

describe("isRateCardMiss", () => {
  it("is true for a model no key prices", () => {
    expect(isRateCardMiss("mistral-large-2")).toBe(true);
    expect(isRateCardMiss("mistral/mistral-large-2")).toBe(true);
  });

  it("is false for a versioned id that prefix-matches a family", () => {
    expect(isRateCardMiss("claude-sonnet-5-20260101")).toBe(false);
    expect(isRateCardMiss("openai/gpt-5-mini-2026-01-01")).toBe(false);
  });
});

describe("the cache-write rate itself (#1411)", () => {
  it("matches billing field for field, on every family", () => {
    // The shapes above compare totals, which can agree by cancellation. This
    // compares the numbers.
    const mismatches: string[] = [];
    for (const entry of RATE_CARD) {
      const billing =
        PROVIDER_RATE_CARD[entry.family] ??
        Object.entries(PROVIDER_RATE_CARD).find(([key]) =>
          key.endsWith(`/${entry.family}`),
        )?.[1];
      if (!billing) continue; // the row above already fails for this family
      for (const field of [
        "inputPer1M",
        "outputPer1M",
        "cachedInputPer1M",
        "cacheWritePer1M",
      ] as const) {
        if (entry.rate[field] !== billing[field]) {
          mismatches.push(
            `${entry.family}.${field}: engine ${entry.rate[field]} vs billing ${billing[field]}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("never prices a write below fresh input, or a read above it", () => {
    // The invariant that would have caught #1411 on its own: pricing a write as
    // fresh input made the two exactly equal on Anthropic, where the real rate
    // is 25% higher.
    for (const entry of RATE_CARD) {
      expect(entry.rate.cacheWritePer1M).toBeGreaterThanOrEqual(
        entry.rate.inputPer1M,
      );
      expect(entry.rate.cachedInputPer1M).toBeLessThanOrEqual(
        entry.rate.inputPer1M,
      );
    }
  });

  it("keeps Anthropic's 25% write premium, and no premium anywhere else", () => {
    for (const entry of RATE_CARD) {
      const expected =
        entry.vendor === "anthropic"
          ? entry.rate.inputPer1M * 1.25
          : entry.rate.inputPer1M;
      expect(entry.rate.cacheWritePer1M).toBeCloseTo(expected, 6);
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  RATE_CARD,
  estimateCostUsd,
} from "@oxagen/agent-engine/router/rate-card";
import { providerCostUsd, isRateCardMiss } from "./pricing";

/**
 * The two rate cards, held together.
 *
 * `packages/agent-engine/src/router/rate-card.ts` prices a model for the cost
 * router and for `oxagen cost`; `pricing.ts` prices the same model for the
 * credits we actually debit. They are separate files on purpose — the engine
 * ships in a standalone bin and must not pull in Stripe — so nothing but this
 * test stops them drifting, and for most of a generation of models nothing did:
 * every family the router gained after `gpt-4o` was missing from the billing
 * card and billed at the Sonnet fallback instead (#1412).
 *
 * A new family therefore fails here until it has a billing row. That is the
 * point: the failure lands on the PR that adds the family, not on a customer's
 * invoice.
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

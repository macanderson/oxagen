/**
 * Contract tests for `get_rate_card` (ADR-052).
 *
 * The kernel validates handler output against this schema, so the schema is
 * the last thing standing between a drifting handler and a customer reading a
 * wrong price. These tests pin the parts of the shape that carry a PROMISE
 * rather than merely a type: the deliberate zero on model tokens, the
 * nullable-means-negotiated allowance, and the literal opt-in on retention.
 */
import { describe, expect, it } from "vitest";
import { billingActionRateCard } from "./billing.action_rate_card";

const validOutput = {
  unit: "governed_action" as const,
  summary: "Governed actions are the billable unit.",
  bands: [
    {
      id: "first-1m",
      minAnnualActions: 0,
      maxAnnualActions: 1_000_000,
      usdPer1000: 20,
    },
    {
      id: "committed-25m-plus",
      minAnnualActions: 25_000_000,
      maxAnnualActions: null,
      usdPer1000: 6,
    },
  ],
  tiers: [
    { tier: "free" as const, includedActionsAnnual: 25_000, retentionMonths: 1 },
    {
      tier: "enterprise" as const,
      includedActionsAnnual: null,
      retentionMonths: 12,
    },
  ],
  retention: { includedMonths: 12, usdPerGbMonth: 0.08, optIn: true as const },
  modelTokens: {
    usdPerToken: 0 as const,
    explanation: "Reported in full, charged at zero — your key paid the vendor.",
  },
  yourTier: "scale" as const,
  yourIncludedActionsAnnual: 1_500_000,
};

describe("billing.action_rate_card contract", () => {
  it("is registered under its ADR-025 verb-first name", () => {
    expect(billingActionRateCard.name).toBe("get_rate_card");
  });

  it("never bills the caller for reading its own price", () => {
    expect(billingActionRateCard.noBillingGate).toBe(true);
  });

  it("parses an empty input and rejects a non-object", () => {
    expect(billingActionRateCard.input.parse({})).toEqual({});
    expect(() => billingActionRateCard.input.parse("nope")).toThrow();
  });

  it("parses a full rate card", () => {
    const parsed = billingActionRateCard.output.parse(validOutput);
    expect(parsed.bands).toHaveLength(2);
    expect(parsed.yourTier).toBe("scale");
  });

  it("lets the top band run to infinity with a null upper bound", () => {
    const parsed = billingActionRateCard.output.parse(validOutput);
    expect(parsed.bands.at(-1)?.maxAnnualActions).toBeNull();
  });

  // The three promises. Each is a literal in the schema precisely so a handler
  // cannot quietly stop making it.
  it("refuses a non-zero model-token price — the zero is the message, not a default", () => {
    expect(() =>
      billingActionRateCard.output.parse({
        ...validOutput,
        modelTokens: { ...validOutput.modelTokens, usdPerToken: 0.000002 },
      }),
    ).toThrow();
  });

  it("refuses to describe retention as anything but opt-in", () => {
    expect(() =>
      billingActionRateCard.output.parse({
        ...validOutput,
        retention: { ...validOutput.retention, optIn: false },
      }),
    ).toThrow();
  });

  it("allows a null tier allowance (negotiated) but not a negative one", () => {
    const negotiated = billingActionRateCard.output.parse(validOutput);
    expect(negotiated.tiers[1]?.includedActionsAnnual).toBeNull();
    expect(() =>
      billingActionRateCard.output.parse({
        ...validOutput,
        tiers: [
          { tier: "free", includedActionsAnnual: -1, retentionMonths: 12 },
        ],
      }),
    ).toThrow();
  });

  it("refuses a retention window of zero months — a tier always retains something", () => {
    expect(() =>
      billingActionRateCard.output.parse({
        ...validOutput,
        tiers: [
          { tier: "free", includedActionsAnnual: 0, retentionMonths: 0 },
        ],
      }),
    ).toThrow();
  });
});

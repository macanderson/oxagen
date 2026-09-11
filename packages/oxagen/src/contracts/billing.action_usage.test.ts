/**
 * Contract tests for `get_action_usage` (ADR-052).
 *
 * This is the shape behind "why is my bill this number", so the schema has to
 * keep two things honest under a drifting handler: the band true-up is money
 * owed BACK to the customer and can never be reported as a negative, and the
 * model-spend line exists with a zero in it rather than being omitted.
 */
import { describe, expect, it } from "vitest";
import { billingActionUsage } from "./billing.action_usage";

const validOutput = {
  period: {
    start: "2026-01-01T00:00:00.000Z",
    end: "2027-01-01T00:00:00.000Z",
  },
  actionsUsed: 1_200_000,
  actionsIncluded: 1_500_000,
  actionsWithinAllowance: 1_200_000,
  actionsCharged: 0,
  actionsRemaining: 300_000,
  band: { id: "1m-5m", usdPer1000: 15 },
  creditsCharged: 0,
  creditsAtFinalBand: 0,
  bandTrueUpCredits: 0,
  meterMode: "charge" as const,
  modelSpend: {
    reportedCostMicros: 4_500_000,
    chargedCredits: 0,
    assistantTokenCredits: 12,
  },
  byCapability: [],
};

describe("billing.action_usage contract", () => {
  it("is registered under its ADR-025 verb-first name", () => {
    expect(billingActionUsage.name).toBe("get_action_usage");
  });

  it("never bills the caller — an org out of credits must still see that it is", () => {
    expect(billingActionUsage.noBillingGate).toBe(true);
  });

  it("defaults the breakdown OFF, because it is a ClickHouse scan and the headline is one row", () => {
    expect(billingActionUsage.input.parse({})).toEqual({
      includeBreakdown: false,
    });
    expect(billingActionUsage.input.parse({ includeBreakdown: true })).toEqual({
      includeBreakdown: true,
    });
  });

  it("rejects a non-boolean breakdown flag", () => {
    expect(() =>
      billingActionUsage.input.parse({ includeBreakdown: "yes" }),
    ).toThrow();
  });

  it("parses a full usage readout", () => {
    const parsed = billingActionUsage.output.parse(validOutput);
    expect(parsed.band.usdPer1000).toBe(15);
    expect(parsed.byCapability).toEqual([]);
  });

  it("carries a per-capability breakdown when one was asked for", () => {
    const parsed = billingActionUsage.output.parse({
      ...validOutput,
      byCapability: [{ capability: "query_ontology", actions: 42 }],
    });
    expect(parsed.byCapability[0]?.capability).toBe("query_ontology");
  });

  it("reports both meter modes, so a counting-not-charging period is visible", () => {
    expect(
      billingActionUsage.output.parse({ ...validOutput, meterMode: "shadow" })
        .meterMode,
    ).toBe("shadow");
    expect(() =>
      billingActionUsage.output.parse({ ...validOutput, meterMode: "off" }),
    ).toThrow();
  });

  // The true-up is the difference between what the incremental recorder
  // charged and what the §4.1 whole-volume rule says. It is owed to the
  // customer, so it is reported as a non-negative magnitude; a negative would
  // mean the customer owed Oxagen, which this field never expresses.
  it("refuses a negative band true-up", () => {
    expect(() =>
      billingActionUsage.output.parse({
        ...validOutput,
        bandTrueUpCredits: -5,
      }),
    ).toThrow();
  });

  it("refuses fractional action counts — an action is a whole thing or it did not happen", () => {
    expect(() =>
      billingActionUsage.output.parse({ ...validOutput, actionsUsed: 1.5 }),
    ).toThrow();
  });

  it("keeps the model-spend line with its deliberate zero rather than allowing it to be dropped", () => {
    const { modelSpend: _dropped, ...withoutModelSpend } = validOutput;
    expect(() =>
      billingActionUsage.output.parse(withoutModelSpend),
    ).toThrow();
    expect(
      billingActionUsage.output.parse(validOutput).modelSpend.chargedCredits,
    ).toBe(0);
  });
});

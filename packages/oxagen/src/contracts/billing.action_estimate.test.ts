/**
 * Contract tests for `preview_action_cost` (ADR-052, spec §3.4).
 *
 * The calculator's reason for existing is that a buyer must be able to CHECK
 * the quote, so the schema requires the assumptions back out — the ratio used
 * and where it came from. A quote whose ratio is hidden is the thing this
 * capability was added to stop shipping.
 */
import { describe, expect, it } from "vitest";
import { billingActionEstimate, RUN_CLASSES } from "./billing.action_estimate";

const validOutput = {
  assumptions: {
    runsPerYear: 250_000,
    actionsPerRun: 15,
    actionsPerRunSource: "run_class" as const,
    runClass: "standard_task" as const,
    tier: "scale" as const,
  },
  actionsPerYear: 3_750_000,
  includedActionsAnnual: 1_500_000,
  overageActions: 2_250_000,
  band: { id: "1m-5m", usdPer1000: 15 },
  overageUsd: 33_750,
  excludes: "Excludes the subscription platform fee and your own model tokens.",
};

describe("billing.action_estimate contract", () => {
  it("is registered under its ADR-025 verb-first name", () => {
    expect(billingActionEstimate.name).toBe("preview_action_cost");
  });

  it("never bills the caller — an estimate is not itself a charge", () => {
    expect(billingActionEstimate.noBillingGate).toBe(true);
  });

  it("publishes the four run classes the spec names", () => {
    expect([...RUN_CLASSES]).toEqual([
      "qa_lookup",
      "standard_task",
      "multi_step",
      "long_running",
    ]);
  });

  it("defaults an unstated run class to the middle of the range", () => {
    const parsed = billingActionEstimate.input.parse({ runsPerYear: 1000 });
    expect(parsed.runClass).toBe("standard_task");
  });

  it("accepts a measured actions-per-run override alongside a run class", () => {
    const parsed = billingActionEstimate.input.parse({
      runsPerYear: 1000,
      runClass: "multi_step",
      actionsPerRun: 42,
    });
    expect(parsed.actionsPerRun).toBe(42);
  });

  it("refuses a run volume that is zero, negative or fractional", () => {
    for (const runsPerYear of [0, -1, 2.5]) {
      expect(() => billingActionEstimate.input.parse({ runsPerYear })).toThrow();
    }
  });

  it("bounds the inputs, so a typo cannot produce a nonsense quote", () => {
    expect(() =>
      billingActionEstimate.input.parse({ runsPerYear: 1_000_000_001 }),
    ).toThrow();
    expect(() =>
      billingActionEstimate.input.parse({
        runsPerYear: 1000,
        actionsPerRun: 10_001,
      }),
    ).toThrow();
  });

  it("refuses an unknown run class or tier", () => {
    expect(() =>
      billingActionEstimate.input.parse({
        runsPerYear: 1000,
        runClass: "overnight",
      }),
    ).toThrow();
    expect(() =>
      billingActionEstimate.input.parse({ runsPerYear: 1000, tier: "platinum" }),
    ).toThrow();
  });

  it("parses a full quote", () => {
    const parsed = billingActionEstimate.output.parse(validOutput);
    expect(parsed.overageUsd).toBe(33_750);
  });

  // The assumptions block is not decoration: without it the ratio is hidden
  // and the buyer cannot reproduce the number.
  it("refuses a quote that does not say which ratio it used", () => {
    const { assumptions: _dropped, ...withoutAssumptions } = validOutput;
    expect(() =>
      billingActionEstimate.output.parse(withoutAssumptions),
    ).toThrow();
  });

  it("refuses a quote that does not say where the ratio came from", () => {
    const { actionsPerRunSource: _dropped, ...rest } = validOutput.assumptions;
    expect(() =>
      billingActionEstimate.output.parse({
        ...validOutput,
        assumptions: rest,
      }),
    ).toThrow();
  });

  it("allows a null included allowance, which means negotiated rather than unlimited", () => {
    const parsed = billingActionEstimate.output.parse({
      ...validOutput,
      assumptions: { ...validOutput.assumptions, tier: "enterprise" },
      includedActionsAnnual: null,
    });
    expect(parsed.includedActionsAnnual).toBeNull();
  });

  it("refuses a negative price", () => {
    expect(() =>
      billingActionEstimate.output.parse({ ...validOutput, overageUsd: -1 }),
    ).toThrow();
  });
});

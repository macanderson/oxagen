/**
 * Unit tests for the preview_action_cost handler (billing.action_estimate).
 *
 * Pure arithmetic, so there is nothing to mock but the logger. Inputs are run
 * through the contract's own input schema so the zod defaults under test are
 * the ones a real caller gets.
 *
 * Covers:
 *  - the spec §4.5 worked example, end to end;
 *  - a caller-measured ratio overriding the published one;
 *  - enterprise's negotiated (null) allowance;
 *  - a volume entirely inside the allowance;
 *  - contract-schema validation on every path.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { billingActionEstimate } from "@oxagen/oxagen/contracts/billing.action_estimate";
import { billingActionEstimateHandler } from "./billing.action_estimate";
import { TEST_CTX } from "./test-utils/fixtures";

/** Parse through the contract so defaults match what the kernel would pass. */
function parseInput(raw: Record<string, unknown>) {
  return billingActionEstimate.input.parse(raw);
}

describe("billingActionEstimateHandler", () => {
  it("reproduces the spec §4.5 worked example", async () => {
    // 50 agents × 20 runs × 250 working days = 250,000 runs/yr, standard task.
    const out = await billingActionEstimateHandler(
      parseInput({ runsPerYear: 250_000, tier: "scale" }),
      TEST_CTX,
    );

    expect(() => billingActionEstimate.output.parse(out)).not.toThrow();
    expect(out.assumptions.actionsPerRun).toBe(15);
    expect(out.assumptions.actionsPerRunSource).toBe("run_class");
    expect(out.assumptions.runClass).toBe("standard_task");
    expect(out.actionsPerYear).toBe(3_750_000);
    expect(out.includedActionsAnnual).toBe(1_500_000);
    expect(out.band.id).toBe("1m-5m");
    expect(out.band.usdPer1000).toBe(15);
    expect(out.overageActions).toBe(2_250_000);
    expect(out.overageUsd).toBeCloseTo(33_750, 6);
  });

  it("defaults the tier to scale and the run class to a standard task", async () => {
    const out = await billingActionEstimateHandler(
      parseInput({ runsPerYear: 1_000 }),
      TEST_CTX,
    );
    expect(() => billingActionEstimate.output.parse(out)).not.toThrow();
    expect(out.assumptions.tier).toBe("scale");
    expect(out.assumptions.runClass).toBe("standard_task");
  });

  it("prefers a caller-measured ratio and says so", async () => {
    const out = await billingActionEstimateHandler(
      parseInput({
        runsPerYear: 100_000,
        runClass: "multi_step",
        actionsPerRun: 7.5,
        tier: "build",
      }),
      TEST_CTX,
    );

    expect(() => billingActionEstimate.output.parse(out)).not.toThrow();
    expect(out.assumptions.actionsPerRun).toBe(7.5);
    expect(out.assumptions.actionsPerRunSource).toBe("caller_supplied");
    // The run class is still echoed — the caller said what their runs look
    // like even though the ratio did not come from it.
    expect(out.assumptions.runClass).toBe("multi_step");
    expect(out.actionsPerYear).toBe(750_000);
    expect(out.includedActionsAnnual).toBe(250_000);
    expect(out.overageActions).toBe(500_000);
    expect(out.band.id).toBe("first-1m");
    expect(out.overageUsd).toBeCloseTo(10_000, 6);
  });

  it("uses each published run class ratio", async () => {
    const expected: Record<string, number> = {
      qa_lookup: 3.5,
      standard_task: 15,
      multi_step: 55,
      long_running: 100,
    };
    for (const [runClass, ratio] of Object.entries(expected)) {
      const out = await billingActionEstimateHandler(
        parseInput({ runsPerYear: 1_000, runClass }),
        TEST_CTX,
      );
      expect(() => billingActionEstimate.output.parse(out)).not.toThrow();
      expect(out.assumptions.actionsPerRun).toBe(ratio);
      expect(out.actionsPerYear).toBe(Math.floor(1_000 * ratio));
    }
  });

  it("quotes enterprise's negotiated allowance as null and does not invent a floor", async () => {
    const out = await billingActionEstimateHandler(
      parseInput({ runsPerYear: 100_000, tier: "enterprise" }),
      TEST_CTX,
    );

    expect(() => billingActionEstimate.output.parse(out)).not.toThrow();
    expect(out.includedActionsAnnual).toBeNull();
    // Null included → the whole projected volume is quoted as overage, the
    // upper bound; the negotiated floor can only improve it.
    expect(out.actionsPerYear).toBe(1_500_000);
    expect(out.overageActions).toBe(1_500_000);
    expect(out.band.id).toBe("1m-5m");
  });

  it("reports zero overage for a volume inside the allowance", async () => {
    const out = await billingActionEstimateHandler(
      parseInput({ runsPerYear: 100, runClass: "qa_lookup", tier: "free" }),
      TEST_CTX,
    );

    expect(() => billingActionEstimate.output.parse(out)).not.toThrow();
    expect(out.actionsPerYear).toBe(350);
    expect(out.includedActionsAnnual).toBe(25_000);
    expect(out.overageActions).toBe(0);
    expect(out.overageUsd).toBe(0);
  });

  it("names the platform fee and BYOK model tokens in the exclusions", async () => {
    const out = await billingActionEstimateHandler(
      parseInput({ runsPerYear: 10 }),
      TEST_CTX,
    );
    expect(out.excludes).toMatch(/platform fee/i);
    expect(out.excludes).toMatch(/token/i);
  });
});

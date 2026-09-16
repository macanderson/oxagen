import { describe, expect, it } from "vitest";
import { evidenceDisclosureGrainSet } from "./evidence.disclosure_grain.set";

describe("set_disclosure_grain contract", () => {
  it("is an unbilled, high-sensitivity write on the API alone", () => {
    expect(evidenceDisclosureGrainSet.noBillingGate).toBe(true);
    expect(evidenceDisclosureGrainSet.mutates).toBe(true);
    expect(evidenceDisclosureGrainSet.sensitivity).toBe("high");
    expect(evidenceDisclosureGrainSet.surfaces).toEqual(["api"]);
  });

  it("accepts the four grains and refuses any other word (negative)", () => {
    for (const grain of ["L0", "L1", "L2", "L3"])
      expect(
        evidenceDisclosureGrainSet.input.safeParse({ grain }).success,
      ).toBe(true);
    expect(
      evidenceDisclosureGrainSet.input.safeParse({ grain: "L4" }).success,
    ).toBe(false);
    expect(
      evidenceDisclosureGrainSet.input.safeParse({ grain: "L1", reason: "x" })
        .success,
    ).toBe(false);
  });

  it("answers a null instant only for a grain nobody ever stored", () => {
    expect(
      evidenceDisclosureGrainSet.output.parse({
        grain: "L0",
        previousGrain: "L0",
        changedAt: null,
      }).changedAt,
    ).toBeNull();
    expect(
      evidenceDisclosureGrainSet.output.parse({
        grain: "L1",
        previousGrain: "L0",
        changedAt: "2026-09-15T09:00:00.000Z",
      }).grain,
    ).toBe("L1");
  });
});

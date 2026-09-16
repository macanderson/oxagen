/**
 * The harness enum is a ratchet: `WRAPPED_HARNESSES` and `CONNECTED_HARNESSES`
 * carry literal types so a per-tier lookup table is total for its tier, which
 * means they are written out rather than derived. This file is what keeps them
 * honest — a harness added to the enum without being classified fails here
 * rather than quietly reading as wrapped, which would have the product claim
 * a step record for an app that produces none (ADR-078 §2).
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTED_HARNESSES,
  isConnectedHarness,
  isWrappedHarness,
  TACHO_HARNESS_LABELS,
  TACHO_HARNESS_TIERS,
  TACHO_TIER_SUMMARY,
  tachoHarnessSchema,
  WRAPPED_HARNESSES,
} from "./wire";

const ALL = tachoHarnessSchema.options;

describe("every harness is classified, exactly once", () => {
  it("the two lists partition the enum", () => {
    expect([...WRAPPED_HARNESSES, ...CONNECTED_HARNESSES].sort()).toEqual(
      [...ALL].sort(),
    );
  });

  it("no harness is in both lists", () => {
    for (const harness of WRAPPED_HARNESSES) {
      expect(CONNECTED_HARNESSES).not.toContain(harness);
    }
  });

  it("the lists agree with the tier map", () => {
    for (const harness of WRAPPED_HARNESSES)
      expect(TACHO_HARNESS_TIERS[harness]).toBe("harness");
    for (const harness of CONNECTED_HARNESSES)
      expect(TACHO_HARNESS_TIERS[harness]).toBe("gateway");
  });

  it("every harness has a label and a tier", () => {
    for (const harness of ALL) {
      expect(TACHO_HARNESS_LABELS[harness]).toBeTruthy();
      expect(TACHO_HARNESS_TIERS[harness]).toBeTruthy();
    }
  });

  it("the predicates agree with the lists", () => {
    for (const harness of ALL) {
      expect(isWrappedHarness(harness)).toBe(
        TACHO_HARNESS_TIERS[harness] === "harness",
      );
      expect(isConnectedHarness(harness)).toBe(
        TACHO_HARNESS_TIERS[harness] === "gateway",
      );
    }
    expect(isWrappedHarness("not-a-harness")).toBe(false);
    expect(isConnectedHarness("not-a-harness")).toBe(false);
  });
});

describe("the tier summaries are the honesty rule in one line each", () => {
  it("the wrapped summary says the record is what the agent reported", () => {
    // ADR-078 §2 / tacho spec §2: harness tier is client_attested, and no
    // surface may say "prevented" where the record says "observed".
    expect(TACHO_TIER_SUMMARY.harness).toContain("every action");
    expect(TACHO_TIER_SUMMARY.harness).toContain("does not run the process");
  });

  it("the connected summary names what it does not record", () => {
    expect(TACHO_TIER_SUMMARY.gateway).toContain("refuses");
    expect(TACHO_TIER_SUMMARY.gateway).toContain("does not record");
  });

  it("neither summary ranks the tiers against the other", () => {
    for (const summary of Object.values(TACHO_TIER_SUMMARY)) {
      expect(summary.toLowerCase()).not.toContain("full coverage");
      expect(summary.toLowerCase()).not.toContain("partial");
      expect(summary.toLowerCase()).not.toContain("better");
      expect(summary.toLowerCase()).not.toContain("limited");
    }
  });
});

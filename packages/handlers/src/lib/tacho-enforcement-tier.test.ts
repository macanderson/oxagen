import { describe, expect, it } from "vitest";
import { hostDerivedTier, resolveIngestedTier } from "./tacho-enforcement-tier";

describe("hostDerivedTier", () => {
  it("reads enforce as harness-level enforcement and everything else as observation", () => {
    expect(hostDerivedTier("enforce")).toBe("harness");
    expect(hostDerivedTier("observe")).toBe("observe");
    expect(hostDerivedTier("paused")).toBe("observe");
    expect(hostDerivedTier(null)).toBe("observe");
    expect(hostDerivedTier(undefined)).toBe("observe");
  });
});

describe("resolveIngestedTier", () => {
  it("never lets a producer raise its own tier", () => {
    expect(resolveIngestedTier("observe", "gateway")).toBe("observe");
    expect(resolveIngestedTier("observe", "harness")).toBe("observe");
    expect(resolveIngestedTier("enforce", "gateway")).toBe("harness");
  });

  it("takes a lower claim at its word, because understating is the honest direction", () => {
    expect(resolveIngestedTier("enforce", "observe")).toBe("observe");
  });

  it("keeps the derived tier when nothing is claimed", () => {
    expect(resolveIngestedTier("enforce", undefined)).toBe("harness");
    expect(resolveIngestedTier("observe", null)).toBe("observe");
  });

  it("falls back to the derived tier for a value outside the vocabulary", () => {
    expect(resolveIngestedTier("observe", "enforced")).toBe("observe");
    expect(resolveIngestedTier("enforce", "")).toBe("harness");
    expect(resolveIngestedTier("enforce", 2 as unknown as string)).toBe(
      "harness",
    );
  });
});

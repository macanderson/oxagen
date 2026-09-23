import { describe, expect, it } from "vitest";
import { containedTierOf, promotedTier } from "./tacho-containment";
describe("contained tier evidence", () => {
  it("requires gateway traffic and the exact registered genesis", () => {
    expect(containedTierOf("gateway", "a", "a")).toBe("contained");
    for (const [tier, receipt, genesis] of [
      ["observe", "a", "a"],
      ["harness", "a", "a"],
      ["gateway", undefined, "a"],
      ["gateway", "a", null],
      ["gateway", "a", "b"],
    ] as const) {
      expect(containedTierOf(tier, receipt, genesis)).toBe(tier);
    }
  });
  it("promotes live gateway sessions while preserving sealed and already-contained tiers", () => {
    expect(promotedTier({ enforcementTier: "gateway" }, "contained")).toBe(
      "contained",
    );
    expect(
      promotedTier(
        { enforcementTier: "observe", sealedAt: new Date() },
        "contained",
      ),
    ).toBe("observe");
    expect(promotedTier({ enforcementTier: "contained" }, "observe")).toBe(
      "contained",
    );
    expect(promotedTier(undefined, "contained")).toBe("contained");
  });
});

import { describe, expect, it } from "vitest";
import { CANCEL_ERROR_REASON, deriveLineageOutcome } from "./lineage-outcome";

describe("deriveLineageOutcome (@oxagen/agent)", () => {
  it("passes pending/running/completed through unchanged", () => {
    expect(deriveLineageOutcome("pending", null)).toBe("pending");
    expect(deriveLineageOutcome("running", null)).toBe("running");
    expect(deriveLineageOutcome("completed", null)).toBe("completed");
  });

  it("maps a genuine failure to 'failed'", () => {
    expect(deriveLineageOutcome("failed", "dispatch emit failed: boom")).toBe(
      "failed",
    );
    expect(deriveLineageOutcome("failed", null)).toBe("failed");
  });

  it("maps the exact cancel error_reason to 'cancelled', distinct from 'failed'", () => {
    expect(deriveLineageOutcome("failed", CANCEL_ERROR_REASON)).toBe(
      "cancelled",
    );
  });

  it("does not treat a reason merely containing 'Cancelled' as a cancellation", () => {
    expect(
      deriveLineageOutcome("failed", "Cancelled something else entirely"),
    ).toBe("failed");
  });

  it("falls back to 'failed' for an unrecognized status (defensive)", () => {
    expect(deriveLineageOutcome("bogus", null)).toBe("failed");
  });
});

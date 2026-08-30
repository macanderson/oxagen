import { describe, expect, it } from "vitest";
import { FanoutNotFoundError, isFanoutNotFoundError } from "./subagent-errors";

describe("FanoutNotFoundError", () => {
  it("carries the fanout id, a stable code, and a descriptive message", () => {
    const err = new FanoutNotFoundError("fan_123");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FanoutNotFoundError);
    expect(err.name).toBe("FanoutNotFoundError");
    expect(err.code).toBe("fanout_not_found");
    expect(err.fanoutId).toBe("fan_123");
    expect(err.message).toBe("Fanout fan_123 not found");
  });
});

describe("isFanoutNotFoundError", () => {
  it("matches a real FanoutNotFoundError instance", () => {
    expect(isFanoutNotFoundError(new FanoutNotFoundError("x"))).toBe(true);
  });

  it("matches a structurally-equivalent error across a package boundary (code discriminant)", () => {
    // Simulates the bundling edge case where two copies of the class identity
    // exist: instanceof would fail, but the `code` discriminant still matches.
    const crossBoundary = Object.assign(new Error("Fanout y not found"), {
      code: "fanout_not_found",
    });
    expect(isFanoutNotFoundError(crossBoundary)).toBe(true);
  });

  it("does NOT match an unrelated error whose message merely contains 'not found'", () => {
    // The core hardening: a Postgres "relation ... not found", a kernel
    // unknown-capability error, or any future message refactor must NOT be
    // misclassified — only the typed error (or its code) counts.
    expect(
      isFanoutNotFoundError(new Error('relation "subagent_fanouts" not found')),
    ).toBe(false);
    expect(
      isFanoutNotFoundError(new Error("Unknown capability not found")),
    ).toBe(false);
  });

  it("does NOT match an error with a different code", () => {
    const other = Object.assign(new Error("nope"), { code: "some_other_code" });
    expect(isFanoutNotFoundError(other)).toBe(false);
  });

  it("does NOT match non-error values", () => {
    expect(isFanoutNotFoundError(null)).toBe(false);
    expect(isFanoutNotFoundError(undefined)).toBe(false);
    expect(isFanoutNotFoundError("Fanout x not found")).toBe(false);
    expect(isFanoutNotFoundError({ code: "fanout_not_found" })).toBe(false);
  });
});

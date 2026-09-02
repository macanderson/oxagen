import { describe, expect, it } from "vitest";
import {
  DEFAULT_SURFACES,
  getSurfaces,
  isDenial,
  type DenialResponse,
} from "./types";

describe("isDenial", () => {
  it("returns true for a well-formed DenialResponse (deny)", () => {
    const denial: DenialResponse = {
      __capabilityDenied: true,
      outcome: "deny",
      reason: "authz_denied",
    };
    expect(isDenial(denial)).toBe(true);
  });

  it("returns true for a pending_approval denial carrying a requestId", () => {
    const denial: DenialResponse = {
      __capabilityDenied: true,
      outcome: "pending_approval",
      reason: "approval_required",
      requestId: "req_123",
    };
    expect(isDenial(denial)).toBe(true);
  });

  // ── negative cases ──────────────────────────────────────────────────────────

  it("returns false for null and undefined", () => {
    expect(isDenial(null)).toBe(false);
    expect(isDenial(undefined)).toBe(false);
  });

  it("returns false for non-object primitives", () => {
    expect(isDenial("deny")).toBe(false);
    expect(isDenial(0)).toBe(false);
    expect(isDenial(true)).toBe(false);
  });

  it("returns false for a plain object without the sentinel", () => {
    expect(isDenial({ outcome: "deny", reason: "x" })).toBe(false);
  });

  it("returns false when the sentinel is present but not strictly true", () => {
    // Guards against a truthy-but-not-true value slipping through (===, not ==).
    expect(isDenial({ __capabilityDenied: 1 })).toBe(false);
    expect(isDenial({ __capabilityDenied: "true" })).toBe(false);
    expect(isDenial({ __capabilityDenied: false })).toBe(false);
  });

  it("narrows the type so an allow result is distinguishable", () => {
    const value: unknown = { value: "ok" };
    if (isDenial(value)) {
      // Type-narrowed branch — must not be reached for a non-denial.
      expect(value.outcome).toBeDefined();
    } else {
      expect(value).toEqual({ value: "ok" });
    }
  });
});

describe("getSurfaces", () => {
  it("returns the declared surfaces when present", () => {
    expect(getSurfaces({ surfaces: ["api", "agent"] })).toEqual([
      "api",
      "agent",
    ]);
  });

  it("falls back to DEFAULT_SURFACES when surfaces is undefined", () => {
    expect(getSurfaces({ surfaces: undefined })).toBe(DEFAULT_SURFACES);
    expect(getSurfaces({})).toEqual(["api", "mcp"]);
  });

  it("DEFAULT_SURFACES is the public api+mcp pair", () => {
    expect(DEFAULT_SURFACES).toEqual(["api", "mcp"]);
  });
});

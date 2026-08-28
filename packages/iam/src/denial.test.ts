// denial.test.ts — unit tests for DenialResponse factory and isDenial guard.

import { describe, expect, it } from "vitest";
import { denial, isDenial } from "./denial";

describe("denial()", () => {
  it("returns a DenialResponse with __capabilityDenied true", () => {
    const d = denial({ outcome: "deny", reason: "no_grant" });
    expect(d.__capabilityDenied).toBe(true);
  });

  it("carries the correct outcome for a deny", () => {
    const d = denial({ outcome: "deny", reason: "workspace_deny" });
    expect(d.outcome).toBe("deny");
    expect(d.reason).toBe("workspace_deny");
  });

  it("carries the correct outcome for pending_approval", () => {
    const d = denial({ outcome: "pending_approval", reason: "no_grant" });
    expect(d.outcome).toBe("pending_approval");
  });

  it("denial with pending_approval includes requestId when provided", () => {
    const d = denial({
      outcome: "pending_approval",
      reason: "require_approval",
      requestId: "arq_abc",
    });
    expect(d.requestId).toBe("arq_abc");
  });

  it("requestId is absent when not provided", () => {
    const d = denial({ outcome: "deny", reason: "no_grant" });
    expect(d.requestId).toBeUndefined();
  });
});

describe("isDenial()", () => {
  it("returns true for a DenialResponse", () => {
    const d = denial({ outcome: "deny", reason: "no_grant" });
    expect(isDenial(d)).toBe(true);
  });

  it("returns false for null", () => {
    expect(isDenial(null)).toBe(false);
  });

  it("returns false for a plain string", () => {
    expect(isDenial("denied")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isDenial(42)).toBe(false);
  });

  it("returns false for a plain object without the sentinel", () => {
    expect(isDenial({ outcome: "deny", reason: "no_grant" })).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isDenial(undefined)).toBe(false);
  });

  it("returns true for pending_approval DenialResponse", () => {
    const d = denial({
      outcome: "pending_approval",
      reason: "require_approval",
    });
    expect(isDenial(d)).toBe(true);
  });

  it("narrowing: TypeScript infers DenialResponse after isDenial check", () => {
    const value: unknown = denial({ outcome: "deny", reason: "expired" });
    if (isDenial(value)) {
      // TypeScript should narrow to DenialResponse here.
      const typed: string = value.reason;
      expect(typed).toBe("expired");
    } else {
      throw new Error("isDenial should have returned true");
    }
  });
});

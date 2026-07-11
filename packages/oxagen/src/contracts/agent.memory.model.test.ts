import { describe, expect, it } from "vitest";
import {
  assertMemoryClassInvariants,
  deriveCompliance,
} from "./agent.memory.model";

describe("assertMemoryClassInvariants", () => {
  it("normalizes an OBSERVATION with a null enforcement score", () => {
    const result = assertMemoryClassInvariants({ memoryClass: "OBSERVATION" });

    expect(result).toEqual({
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      confirmedByKind: null,
      confirmedById: null,
    });
  });

  it("passes through confirmation fields for an OBSERVATION", () => {
    const result = assertMemoryClassInvariants({
      memoryClass: "OBSERVATION",
      confirmedByKind: "AGENT",
      confirmedById: "agt_1",
    });

    expect(result.confirmedByKind).toBe("AGENT");
    expect(result.confirmedById).toBe("agt_1");
  });

  it("requires a USER confirmation for a FACT", () => {
    expect(() =>
      assertMemoryClassInvariants({
        memoryClass: "FACT",
        confirmedByKind: "AGENT",
      }),
    ).toThrow("A FACT requires confirmed_by_kind = USER");
  });

  it("forces enforcementScore to 100 for a USER-confirmed FACT", () => {
    const result = assertMemoryClassInvariants({
      memoryClass: "FACT",
      confirmedByKind: "USER",
      confirmedById: "u_1",
      enforcementScore: 10,
    });

    expect(result).toEqual({
      memoryClass: "FACT",
      enforcementScore: 100,
      confirmedByKind: "USER",
      confirmedById: "u_1",
    });
  });

  it("rejects a RULE with no enforcement score", () => {
    expect(() => assertMemoryClassInvariants({ memoryClass: "RULE" })).toThrow(
      "A RULE requires enforcement_score between 1 and 100",
    );
  });

  it("rejects a RULE with an out-of-range enforcement score", () => {
    expect(() =>
      assertMemoryClassInvariants({ memoryClass: "RULE", enforcementScore: 0 }),
    ).toThrow("A RULE requires enforcement_score between 1 and 100");
    expect(() =>
      assertMemoryClassInvariants({
        memoryClass: "RULE",
        enforcementScore: 101,
      }),
    ).toThrow("A RULE requires enforcement_score between 1 and 100");
  });

  it("accepts a RULE with a valid enforcement score", () => {
    const result = assertMemoryClassInvariants({
      memoryClass: "RULE",
      enforcementScore: 70,
      confirmedByKind: "SYSTEM",
      confirmedById: null,
    });

    expect(result).toEqual({
      memoryClass: "RULE",
      enforcementScore: 70,
      confirmedByKind: "SYSTEM",
      confirmedById: null,
    });
  });
});

describe("deriveCompliance", () => {
  it("is NA for a memory with no enforcement score", () => {
    expect(deriveCompliance({ enforcement: null, deviated: true })).toBe("NA");
    expect(deriveCompliance({ enforcement: undefined, deviated: false })).toBe(
      "NA",
    );
  });

  it("is COMPLIED when the citation did not deviate", () => {
    expect(deriveCompliance({ enforcement: 90, deviated: false })).toBe(
      "COMPLIED",
    );
  });

  it("is VIOLATION when deviated and enforcement meets the default threshold", () => {
    expect(deriveCompliance({ enforcement: 70, deviated: true })).toBe(
      "VIOLATION",
    );
  });

  it("is DISCRETION when deviated but enforcement is below the default threshold", () => {
    expect(deriveCompliance({ enforcement: 69, deviated: true })).toBe(
      "DISCRETION",
    );
  });

  it("honors a custom threshold", () => {
    expect(
      deriveCompliance({ enforcement: 50, deviated: true, threshold: 40 }),
    ).toBe("VIOLATION");
    expect(
      deriveCompliance({ enforcement: 50, deviated: true, threshold: 60 }),
    ).toBe("DISCRETION");
// The two-axis memory model (docs/specs/two-axis-memory) puts hard invariants on
// the class↔enforcement↔confirmation triple, and derives a citation's compliance
// outcome from the enforcement weight. Both are pure and are the single source of
// truth re-used by every agent.memory.* handler, so they carry their own tests.

describe("assertMemoryClassInvariants", () => {
  it("normalizes an OBSERVATION to null enforcement, preserving confirmation fields", () => {
    expect(
      assertMemoryClassInvariants({
        memoryClass: "OBSERVATION",
        // An OBSERVATION ignores any enforcement passed in.
        enforcementScore: 55,
        confirmedByKind: "AGENT",
        confirmedById: "agt_1",
      }),
    ).toEqual({
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      confirmedByKind: "AGENT",
      confirmedById: "agt_1",
    });
  });

  it("defaults an OBSERVATION's confirmation fields to null", () => {
    expect(assertMemoryClassInvariants({ memoryClass: "OBSERVATION" })).toEqual({
      memoryClass: "OBSERVATION",
      enforcementScore: null,
      confirmedByKind: null,
      confirmedById: null,
    });
  });

  it("pins a FACT to enforcement 100 and requires USER confirmation", () => {
    expect(
      assertMemoryClassInvariants({
        memoryClass: "FACT",
        confirmedByKind: "USER",
        confirmedById: "usr_9",
      }),
    ).toEqual({
      memoryClass: "FACT",
      enforcementScore: 100,
      confirmedByKind: "USER",
      confirmedById: "usr_9",
    });
  });

  it("throws when a FACT is not confirmed by a human", () => {
    expect(() =>
      assertMemoryClassInvariants({ memoryClass: "FACT", confirmedByKind: "AGENT" }),
    ).toThrow(/FACT requires confirmed_by_kind = USER/);
    expect(() =>
      assertMemoryClassInvariants({ memoryClass: "FACT", confirmedByKind: null }),
    ).toThrow(/must confirm/);
  });

  it("accepts a RULE with an in-range enforcement score", () => {
    expect(
      assertMemoryClassInvariants({
        memoryClass: "RULE",
        enforcementScore: 70,
        confirmedByKind: "AGENT",
        confirmedById: "agt_2",
      }),
    ).toEqual({
      memoryClass: "RULE",
      enforcementScore: 70,
      confirmedByKind: "AGENT",
      confirmedById: "agt_2",
    });
  });

  it("defaults a RULE's confirmation fields to null", () => {
    expect(
      assertMemoryClassInvariants({ memoryClass: "RULE", enforcementScore: 1 }),
    ).toEqual({
      memoryClass: "RULE",
      enforcementScore: 1,
      confirmedByKind: null,
      confirmedById: null,
    });
  });

  it("throws when a RULE's enforcement is missing or out of the 1..100 range", () => {
    expect(() => assertMemoryClassInvariants({ memoryClass: "RULE" })).toThrow(
      /RULE requires enforcement_score between 1 and 100/,
    );
    expect(() =>
      assertMemoryClassInvariants({ memoryClass: "RULE", enforcementScore: null }),
    ).toThrow(/between 1 and 100/);
    expect(() =>
      assertMemoryClassInvariants({ memoryClass: "RULE", enforcementScore: 0 }),
    ).toThrow(/between 1 and 100/);
    expect(() =>
      assertMemoryClassInvariants({ memoryClass: "RULE", enforcementScore: 101 }),
    ).toThrow(/between 1 and 100/);
  });
});

describe("deriveCompliance", () => {
  it("returns NA for a non-rule (null/undefined enforcement)", () => {
    expect(deriveCompliance({ enforcement: null, deviated: true })).toBe("NA");
    expect(deriveCompliance({ enforcement: undefined, deviated: false })).toBe("NA");
  });

  it("returns COMPLIED when a rule was followed", () => {
    expect(deriveCompliance({ enforcement: 90, deviated: false })).toBe("COMPLIED");
  });

  it("returns VIOLATION when a deviation crosses the threshold (default 70)", () => {
    expect(deriveCompliance({ enforcement: 70, deviated: true })).toBe("VIOLATION");
    expect(deriveCompliance({ enforcement: 100, deviated: true })).toBe("VIOLATION");
  });

  it("returns DISCRETION when a deviation stays below the threshold", () => {
    expect(deriveCompliance({ enforcement: 69, deviated: true })).toBe("DISCRETION");
  });

  it("honors a custom threshold", () => {
    // At enforcement 50 with a raised threshold of 60, a deviation is discretionary.
    expect(deriveCompliance({ enforcement: 50, deviated: true, threshold: 60 })).toBe(
      "DISCRETION",
    );
    // Lower the threshold below the enforcement and the same deviation is a violation.
    expect(deriveCompliance({ enforcement: 50, deviated: true, threshold: 40 })).toBe(
      "VIOLATION",
    );
  });
});

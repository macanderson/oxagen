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
  });
});

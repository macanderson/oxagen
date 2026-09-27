import type { AuthorizationAnswer } from "@cedar-policy/cedar-wasm/nodejs";
import { describe, expect, it } from "vitest";
import { readCedarDecision, stricterVerdict, type CedarVerdict } from "./decision";

function answer(
  decision: "allow" | "deny",
  reason: string[],
  errors: { policyId: string; message: string }[] = [],
): AuthorizationAnswer {
  return {
    type: "success",
    warnings: [],
    response: {
      decision,
      diagnostics: {
        reason,
        errors: errors.map((e) => ({
          policyId: e.policyId,
          error: { message: e.message, help: null, code: null, url: null, severity: null },
        })),
      },
    },
  };
}

describe("readCedarDecision", () => {
  it("reads an allow as an allow", () => {
    expect(readCedarDecision(answer("allow", ["grant.tools"]), [])).toEqual({
      decision: "allow",
      reasons: ["grant.tools"],
      errors: [],
    });
  });

  it("parks a deny when every deciding rule asks for approval", () => {
    const verdict = readCedarDecision(
      answer("deny", ["refund.over-100", "irreversible.approval"]),
      ["irreversible.approval", "refund.over-100"],
    );
    expect(verdict).toEqual({
      decision: "require_approval",
      reasons: ["irreversible.approval", "refund.over-100"],
      errors: [],
    });
  });

  it("denies when one deciding rule does not ask for approval", () => {
    const verdict = readCedarDecision(
      answer("deny", ["refund.over-100", "repo.delete-never"]),
      new Set(["refund.over-100"]),
    );
    expect(verdict.decision).toBe("deny");
  });

  it("denies a call no rule permitted", () => {
    expect(readCedarDecision(answer("deny", []), ["refund.over-100"])).toEqual({
      decision: "deny",
      reasons: [],
      errors: [],
    });
  });

  it("denies when a rule errors, whatever the others say", () => {
    const verdict = readCedarDecision(
      answer("allow", ["grant.tools"], [{ policyId: "limit", message: "overflow" }]),
      [],
    );
    expect(verdict).toEqual({
      decision: "deny",
      reasons: ["grant.tools"],
      errors: ["limit: overflow"],
    });
  });

  it("denies when Cedar cannot answer", () => {
    const verdict = readCedarDecision(
      {
        type: "failure",
        warnings: [],
        errors: [{ message: "context is invalid", help: null, code: null, url: null, severity: null }],
      },
      [],
    );
    expect(verdict).toEqual({ decision: "deny", reasons: [], errors: ["context is invalid"] });
  });
});

describe("stricterVerdict", () => {
  const allow: CedarVerdict = { decision: "allow", reasons: ["a"], errors: [] };
  const park: CedarVerdict = { decision: "require_approval", reasons: ["p"], errors: [] };
  const deny: CedarVerdict = { decision: "deny", reasons: ["d"], errors: [] };

  it("prefers a deny, then an approval, then an allow", () => {
    expect(stricterVerdict(allow, park)).toBe(park);
    expect(stricterVerdict(park, allow)).toBe(park);
    expect(stricterVerdict(park, deny)).toBe(deny);
    expect(stricterVerdict(deny, allow)).toBe(deny);
  });

  it("keeps the first verdict on a tie", () => {
    const other: CedarVerdict = { decision: "allow", reasons: ["b"], errors: [] };
    expect(stricterVerdict(allow, other)).toBe(allow);
  });
});

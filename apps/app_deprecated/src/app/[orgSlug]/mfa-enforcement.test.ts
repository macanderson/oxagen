import { describe, it, expect } from "vitest";
import { evaluateMfaGate, type MfaGateInput } from "./mfa-enforcement";

const NOW = new Date("2026-07-04T12:00:00.000Z");
// Policy written 100 hours ago — well past any small grace window.
const LONG_AGO = new Date(NOW.getTime() - 100 * 60 * 60 * 1000);

function input(overrides: Partial<MfaGateInput>): MfaGateInput {
  return {
    role: "admin",
    twoFactorEnabled: false,
    policy: { mfaRequired: true, mfaGraceHours: 48, updatedAt: LONG_AGO },
    now: NOW,
    ...overrides,
  };
}

describe("evaluateMfaGate", () => {
  it("redirects an unenrolled admin whose org requires MFA past the grace window", () => {
    expect(evaluateMfaGate(input({}))).toEqual({
      action: "redirect-enroll",
      reason: "grace-expired",
    });
  });

  it("redirects an unenrolled owner (owner is privileged too)", () => {
    expect(evaluateMfaGate(input({ role: "owner" })).action).toBe(
      "redirect-enroll",
    );
  });

  it("is case-insensitive on the role (DB stores mixed casing)", () => {
    expect(evaluateMfaGate(input({ role: "Admin" })).action).toBe(
      "redirect-enroll",
    );
  });

  it("allows an enrolled admin", () => {
    expect(evaluateMfaGate(input({ twoFactorEnabled: true }))).toEqual({
      action: "allow",
    });
  });

  it("allows a non-privileged member even when the org requires MFA", () => {
    expect(evaluateMfaGate(input({ role: "member" }))).toEqual({
      action: "allow",
    });
  });

  it("allows when the role is unresolved (null)", () => {
    expect(evaluateMfaGate(input({ role: null }))).toEqual({ action: "allow" });
  });

  it("allows when the org has no policy row", () => {
    expect(evaluateMfaGate(input({ policy: null }))).toEqual({
      action: "allow",
    });
  });

  it("allows when the org policy does not require MFA", () => {
    expect(
      evaluateMfaGate(
        input({
          policy: {
            mfaRequired: false,
            mfaGraceHours: 48,
            updatedAt: LONG_AGO,
          },
        }),
      ),
    ).toEqual({ action: "allow" });
  });

  it("allows an unenrolled admin still inside the grace window", () => {
    // Policy written 1 hour ago, 48h grace → 47h of grace remain.
    const recent = new Date(NOW.getTime() - 1 * 60 * 60 * 1000);
    expect(
      evaluateMfaGate(
        input({
          policy: { mfaRequired: true, mfaGraceHours: 48, updatedAt: recent },
        }),
      ),
    ).toEqual({ action: "allow" });
  });

  it("enforces immediately when grace is 0 hours and the deadline has passed", () => {
    // Grace 0 → deadline == updatedAt; any now after it enforces.
    const justNow = new Date(NOW.getTime() - 1);
    expect(
      evaluateMfaGate(
        input({
          policy: { mfaRequired: true, mfaGraceHours: 0, updatedAt: justNow },
        }),
      ).action,
    ).toBe("redirect-enroll");
  });
});

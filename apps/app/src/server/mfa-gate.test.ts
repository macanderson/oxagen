import { describe, expect, it } from "vitest";
import {
  MFA_ENROLL_PATH,
  evaluateMfaGate,
  mfaGateApplies,
  type MfaPolicy,
} from "./mfa-gate";

const now = new Date("2026-09-12T12:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const required = (graceHours: number, setHoursAgo: number): MfaPolicy => ({
  mfaRequired: true,
  mfaGraceHours: graceHours,
  updatedAt: hoursAgo(setHoursAgo),
});

describe("evaluateMfaGate", () => {
  it("sends an unenrolled owner to enrollment once the grace window has passed", () => {
    expect(
      evaluateMfaGate({
        role: "owner",
        twoFactorEnabled: false,
        policy: required(24, 25),
        now,
      }),
    ).toEqual({ action: "enroll", reason: "grace_expired" });
  });

  it("gates admin in any casing (org_users.role is written in both casings)", () => {
    expect(
      evaluateMfaGate({
        role: "Admin",
        twoFactorEnabled: false,
        policy: required(0, 1),
        now,
      }).action,
    ).toBe("enroll");
  });

  it("allows inside the grace window", () => {
    expect(
      evaluateMfaGate({
        role: "owner",
        twoFactorEnabled: false,
        policy: required(24, 23),
        now,
      }).action,
    ).toBe("allow");
  });

  it("allows an enrolled owner", () => {
    expect(
      evaluateMfaGate({
        role: "owner",
        twoFactorEnabled: true,
        policy: required(0, 100),
        now,
      }).action,
    ).toBe("allow");
  });

  it.each(["member", "billing", null])("does not gate role %s", (role) => {
    expect(
      evaluateMfaGate({
        role,
        twoFactorEnabled: false,
        policy: required(0, 100),
        now,
      }).action,
    ).toBe("allow");
  });

  it("does not gate an organization that has not opted in", () => {
    expect(
      evaluateMfaGate({
        role: "owner",
        twoFactorEnabled: false,
        policy: null,
        now,
      }).action,
    ).toBe("allow");
    expect(
      evaluateMfaGate({
        role: "owner",
        twoFactorEnabled: false,
        policy: { ...required(0, 100), mfaRequired: false },
        now,
      }).action,
    ).toBe("allow");
  });
});

describe("mfaGateApplies", () => {
  it("is true only for a privileged role under a required policy", () => {
    expect(mfaGateApplies("owner", required(1, 0))).toBe(true);
    expect(mfaGateApplies("member", required(1, 0))).toBe(false);
    expect(mfaGateApplies(null, required(1, 0))).toBe(false);
    expect(mfaGateApplies("owner", null)).toBe(false);
  });
});

it("enrolls outside the [org] segment so the redirect cannot loop", () => {
  expect(MFA_ENROLL_PATH.startsWith("/two-factor")).toBe(true);
});

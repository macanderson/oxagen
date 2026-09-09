import { describe, expect, it } from "vitest";
import { tachoEnrollmentCreate } from "./tacho.enrollment.create";

const KEY = `ed25519:${"A".repeat(44)}`;

describe("tachoEnrollmentCreate", () => {
  it("accepts a host description and applies the defaults", () => {
    const parsed = tachoEnrollmentCreate.input.parse({
      hostname: "laptop.local",
      osUser: "dev",
      platform: "darwin",
      devicePublicKey: KEY,
      harnesses: ["claude-code"],
    });
    expect(parsed.validityDays).toBe(180);
    expect(parsed.managed).toBe(false);
  });

  it("refuses an unknown platform, a malformed key, an empty harness list, and a stray member", () => {
    const base = {
      hostname: "h",
      osUser: "u",
      platform: "darwin",
      devicePublicKey: KEY,
      harnesses: ["claude-code"],
    };
    expect(
      tachoEnrollmentCreate.input.safeParse({ ...base, platform: "freebsd" })
        .success,
    ).toBe(false);
    expect(
      tachoEnrollmentCreate.input.safeParse({
        ...base,
        devicePublicKey: "rsa:abc",
      }).success,
    ).toBe(false);
    expect(
      tachoEnrollmentCreate.input.safeParse({ ...base, harnesses: [] }).success,
    ).toBe(false);
    expect(
      tachoEnrollmentCreate.input.safeParse({
        ...base,
        apiKey: "self-asserted",
      }).success,
    ).toBe(false);
    expect(
      tachoEnrollmentCreate.input.safeParse({ ...base, validityDays: 366 })
        .success,
    ).toBe(false);
  });

  it("is an operator-only capability", () => {
    expect(tachoEnrollmentCreate.name).toBe("create_tacho_enrollment");
    expect(tachoEnrollmentCreate.surfaces).toEqual(["api"]);
    expect(tachoEnrollmentCreate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });
});

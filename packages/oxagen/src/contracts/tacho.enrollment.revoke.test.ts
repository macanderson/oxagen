import { describe, expect, it } from "vitest";
import { tachoEnrollmentRevoke } from "./tacho.enrollment.revoke";

describe("tachoEnrollmentRevoke", () => {
  it("accepts a host id with an optional reason and answers revoked", () => {
    expect(
      tachoEnrollmentRevoke.input.parse({
        hostEnrollmentId: "tch_0123456789abcdefghjkmn",
        reason: "lost laptop",
      }).reason,
    ).toBe("lost laptop");
    expect(
      tachoEnrollmentRevoke.input.safeParse({
        hostEnrollmentId: "aky_0123456789abcdefghjkmn",
      }).success,
    ).toBe(false);
    expect(
      tachoEnrollmentRevoke.output.parse({
        hostEnrollmentId: "tch_0123456789abcdefghjkmn",
        status: "revoked",
        revokedAt: "2026-09-08T10:00:00.000Z",
      }).status,
    ).toBe("revoked");
    expect(tachoEnrollmentRevoke.name).toBe("revoke_tacho_enrollment");
  });
});

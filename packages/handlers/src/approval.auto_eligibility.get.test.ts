// get_auto_eligibility's state, read apart from who resolved the request
// (#3521). The query itself is proven against Postgres in
// approval_rule.handlers.pg.test.ts; this is the pure rule the handler applies
// to the row it read.
import { describe, expect, it } from "vitest";
import { approvalStateOf } from "./approval.auto_eligibility.get";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const LATER = new Date("2026-09-23T13:00:00.000Z");
const EARLIER = new Date("2026-09-23T11:00:00.000Z");

describe("approvalStateOf", () => {
  it("is pending only with no resolution and an expiry still ahead", () => {
    expect(approvalStateOf({ resolution: null, expiresAt: LATER }, NOW)).toBe(
      "pending",
    );
  });

  it("reads a recorded resolution as recorded, whatever the expiry says", () => {
    for (const resolution of ["approved", "denied", "expired"] as const) {
      expect(approvalStateOf({ resolution, expiresAt: LATER }, NOW)).toBe(
        resolution,
      );
      expect(approvalStateOf({ resolution, expiresAt: EARLIER }, NOW)).toBe(
        resolution,
      );
    }
  });

  // The mandate revoke and expiry paths write `expired` with no resolver; the
  // sweep may not have run yet on a request whose expiry passed. Both are
  // closed, because resolve_approval refuses both as approval_expired.
  it("is expired once the expiry has passed with nothing recorded", () => {
    expect(approvalStateOf({ resolution: null, expiresAt: EARLIER }, NOW)).toBe(
      "expired",
    );
    expect(approvalStateOf({ resolution: null, expiresAt: NOW }, NOW)).toBe(
      "expired",
    );
  });

  it("never offers a row with an unknown stored resolution as pending", () => {
    expect(
      approvalStateOf({ resolution: "withdrawn", expiresAt: LATER }, NOW),
    ).toBe("expired");
  });
});

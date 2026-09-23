import { describe, expect, it } from "vitest";
import { readFailure, unanswered } from "./action-failure";

const WORDS = {
  refused: { org_role_required: "orgRoleRequired", run_sealed: "runSealed" },
  invalid: { steer_text: "steerText" },
  unavailable: { time_zone_unavailable: "timeZoneUnavailable" },
} as const;

describe("readFailure", () => {
  it("names a refused code the page has a sentence for, under any of the three refused reasons", () => {
    for (const reason of ["denied", "not_found", "conflict"] as const) {
      expect(
        readFailure(WORDS, { ok: false, reason, code: "run_sealed" }),
      ).toEqual({ kind: "named", key: "runSealed" });
    }
  });

  it("prints any other refused code as recorded", () => {
    expect(
      readFailure(WORDS, { ok: false, reason: "denied", code: "forbidden" }),
    ).toEqual({ kind: "refused", code: "forbidden" });
  });

  it("reads an invalid input as invalid unless the page names its code", () => {
    expect(
      readFailure(WORDS, { ok: false, reason: "invalid", code: "steer_text" }),
    ).toEqual({ kind: "named", key: "steerText" });
    expect(
      readFailure(WORDS, { ok: false, reason: "invalid", code: "other" }),
    ).toEqual({ kind: "invalid" });
  });

  it("names the access request a parked write waits on", () => {
    expect(
      readFailure(WORDS, {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_1",
      }),
    ).toEqual({ kind: "pendingApproval", accessRequestId: "acr_1" });
  });

  it("names the code of an unavailable or exhausted answer, unless the page has a sentence for it", () => {
    expect(readFailure(WORDS, unanswered("action_failed"))).toEqual({
      kind: "unavailable",
      code: "action_failed",
    });
    expect(
      readFailure(WORDS, {
        ok: false,
        reason: "exhausted",
        code: "gau_exhausted",
      }),
    ).toEqual({ kind: "unavailable", code: "gau_exhausted" });
    expect(
      readFailure(WORDS, {
        ok: false,
        reason: "unavailable",
        code: "time_zone_unavailable",
      }),
    ).toEqual({ kind: "named", key: "timeZoneUnavailable" });
  });

  it("does not take a prototype member for a page's sentence (negative)", () => {
    expect(
      readFailure(WORDS, { ok: false, reason: "denied", code: "constructor" }),
    ).toEqual({ kind: "refused", code: "constructor" });
  });
});

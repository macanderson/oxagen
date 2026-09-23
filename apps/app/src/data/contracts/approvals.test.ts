// The approvals view model: the note bound it mirrors from `resolve_approval`,
// and how a recorded state becomes the settlement the decision dialog names
// (#3521).
import { APPROVAL_NOTE_MAX as CONTRACT_APPROVAL_NOTE_MAX } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { describe, expect, it } from "vitest";
import { APPROVAL_NOTE_MAX, toApprovalSettlement } from "./approvals";

// The decision dialog is a client component, and the contract module
// registers its capability when it loads, so the bound is mirrored in
// `./approvals` and this test keeps the mirror honest. Tests run under Node,
// where the contract imports fine.
describe("approvals contract mirrors", () => {
  it("mirrors the note bound resolve_approval enforces", () => {
    expect(APPROVAL_NOTE_MAX).toBe(CONTRACT_APPROVAL_NOTE_MAX);
  });
});

describe("toApprovalSettlement", () => {
  it("answers null only while the request is pending", () => {
    expect(
      toApprovalSettlement({
        state: "pending",
        resolvedBy: null,
        resolvedByName: null,
      }),
    ).toBeNull();
  });

  it("names a person by display name, keeping the public id apart from it", () => {
    expect(
      toApprovalSettlement({
        state: "approved",
        resolvedBy: "user:usr_marcusbell",
        resolvedByName: "Marcus Bell",
      }),
    ).toEqual({
      by: "person",
      resolution: "approved",
      id: "usr_marcusbell",
      name: "Marcus Bell",
    });
    expect(
      toApprovalSettlement({
        state: "denied",
        resolvedBy: "user:usr_marcusbell",
        resolvedByName: null,
      }),
    ).toEqual({
      by: "person",
      resolution: "denied",
      id: "usr_marcusbell",
      name: null,
    });
  });

  it("names a rule by its id", () => {
    expect(
      toApprovalSettlement({
        state: "approved",
        resolvedBy: "policy:small-vendor-payments",
        resolvedByName: null,
      }),
    ).toEqual({
      by: "rule",
      resolution: "approved",
      rule: "small-vendor-payments",
    });
  });

  // A mandate revoke or expiry writes `expired` and no resolver. Reading the
  // null resolver as pending offered a decision the handler refuses.
  it("reads a closed request with no resolver as settled, not pending (negative)", () => {
    expect(
      toApprovalSettlement({
        state: "expired",
        resolvedBy: null,
        resolvedByName: null,
      }),
    ).toEqual({ by: "none", resolution: "expired" });
  });
});

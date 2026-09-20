/**
 * Unit tests for the pure decision core of
 * `tools/scripts/assistant-model-keys.ts` (ADR-131, residue #3600).
 *
 * Each describe block below covers a decision that shipped wrong on #3598 and
 * whose wrongness the script's own output concealed.
 */
import { describe, expect, it } from "vitest";
import {
  classifyBackfillOutcome,
  hasCeilingDrift,
  isLiveAtVendorButDisabledHere,
  parseLimitFlag,
  type VendorKeyFacts,
} from "./assistant-model-keys";

describe("parseLimitFlag", () => {
  it("reads a positive whole number", () => {
    expect(parseLimitFlag(["backfill", "--apply", "--limit", "20"])).toEqual({
      ok: true,
      limit: 20,
    });
  });

  it("treats an absent flag as no cap", () => {
    expect(parseLimitFlag(["backfill", "--apply"])).toEqual({
      ok: true,
      limit: Number.POSITIVE_INFINITY,
    });
  });

  it.each([
    ["nonnumeric", "nope"],
    ["zero", "0"],
    ["negative", "-5"],
    ["nonintegral", "2.5"],
    ["empty", "  "],
    ["infinity spelled out", "Infinity"],
  ])("refuses a %s limit rather than removing the cap", (_label, raw) => {
    expect(parseLimitFlag(["backfill", "--apply", "--limit", raw])).toEqual({
      ok: false,
      got: raw,
    });
  });

  it("refuses a trailing --limit with no value", () => {
    expect(parseLimitFlag(["backfill", "--apply", "--limit"])).toEqual({
      ok: false,
      got: undefined,
    });
  });

  it("refuses a --limit swallowed by the next flag", () => {
    expect(parseLimitFlag(["backfill", "--limit", "--apply"])).toEqual({
      ok: false,
      got: "--apply",
    });
  });
});

describe("classifyBackfillOutcome", () => {
  it("counts a mint", () => {
    expect(classifyBackfillOutcome({ provisioned: true })).toBe("minted");
  });

  it.each(["already", "race"])(
    "counts %s as a skip, because a key exists either way",
    (reason) => {
      expect(classifyBackfillOutcome({ provisioned: false, reason })).toBe(
        "skipped",
      );
    },
  );

  it.each(["error", "disabled"])(
    "counts %s as a failure, because no key exists afterwards",
    (reason) => {
      expect(classifyBackfillOutcome({ provisioned: false, reason })).toBe(
        "failed",
      );
    },
  );

  it("counts an unrecognised reason as a failure", () => {
    expect(
      classifyBackfillOutcome({ provisioned: false, reason: "something new" }),
    ).toBe("failed");
  });
});

const vendorKey = (over: Partial<VendorKeyFacts> = {}): VendorKeyFacts => ({
  hash: "h1",
  disabled: false,
  limit: 25,
  limitReset: "daily",
  ...over,
});

describe("isLiveAtVendorButDisabledHere", () => {
  it("is false for a row that is active here", () => {
    expect(
      isLiveAtVendorButDisabledHere({ status: "active", keyHash: "h1" }, [
        vendorKey(),
      ]),
    ).toBe(false);
  });

  it("is true for a row disabled here whose key still spends", () => {
    expect(
      isLiveAtVendorButDisabledHere({ status: "disabled", keyHash: "h1" }, [
        vendorKey({ disabled: false }),
      ]),
    ).toBe(true);
  });

  it("is false when the vendor key is disabled too", () => {
    expect(
      isLiveAtVendorButDisabledHere({ status: "disabled", keyHash: "h1" }, [
        vendorKey({ disabled: true }),
      ]),
    ).toBe(false);
  });

  it("is false when no vendor key matches, rather than reading absent as live", () => {
    expect(
      isLiveAtVendorButDisabledHere({ status: "disabled", keyHash: "gone" }, [
        vendorKey({ hash: "h1" }),
      ]),
    ).toBe(false);
    expect(
      isLiveAtVendorButDisabledHere({ status: "disabled", keyHash: "h1" }, []),
    ).toBe(false);
  });
});

describe("hasCeilingDrift", () => {
  it("is false when the dollar figure and the window both match", () => {
    expect(hasCeilingDrift(vendorKey({ limit: 25 }), 25)).toBe(false);
  });

  it("is true when the dollar figure differs", () => {
    expect(hasCeilingDrift(vendorKey({ limit: 50 }), 25)).toBe(true);
  });

  it.each(["weekly", "monthly", null])(
    "is true when the window is %s even though the dollar figure matches",
    (limitReset) => {
      expect(hasCeilingDrift(vendorKey({ limit: 25, limitReset }), 25)).toBe(
        true,
      );
    },
  );

  it("is true when the vendor carries no ceiling at all", () => {
    expect(hasCeilingDrift(vendorKey({ limit: null }), 25)).toBe(true);
  });
});

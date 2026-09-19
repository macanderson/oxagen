// `readsEveryMandate` (#2957): which readers a mandate surface may tell that no
// authority exists. `list_mandates` answers a non-accountable reader a
// successful list narrowed to the agents they created (`readerFilter`,
// packages/handlers/src/_mandate.ts), so an empty answer to such a reader is
// not evidence of an empty ledger and no surface may present it as one.
import { describe, expect, it } from "vitest";
import type { OrgRole } from "./common";
import { mandateList, mandateRow } from "@/test/mandate-views";
import {
  blindSpotOf,
  CONSEQUENCE_OTHER_MAX,
  CONSEQUENCE_TAG,
  isChangeable,
  isEffective,
  isUpcoming,
  MANDATE_APPROVER,
  MEASURE_NAME,
  MEASURE_NAME_MAX,
  MEASURE_VALUE,
  PURPOSE_MAX,
  UNIT_MAX,
} from "./mandates";

describe("isEffective", () => {
  const at = new Date("2026-09-16T12:00:00.000Z");
  const row = (over: Parameters<typeof mandateRow>[0]) => mandateRow(over);

  it("is an active mandate inside its window, and only that", () => {
    expect(isEffective(row({}), at)).toBe(true);
  });

  it.each([["draft"], ["revoked"], ["expired"]] as const)(
    "%s authorizes nothing, whatever its window says (negative)",
    (status) => {
      expect(isEffective(row({ status }), at)).toBe(false);
    },
  );

  it("is false before the first day, and true on it", () => {
    const from = "2026-09-17T00:00:00.000Z";
    expect(isEffective(row({ validFrom: from }), at)).toBe(false);
    expect(isEffective(row({ validFrom: from }), new Date(from))).toBe(true);
  });

  // The window is half-open because enforcement's is: `findCoveringMandate`
  // selects on `gt(m.validTo, args.at)` (packages/rules/src/mandates.ts:472).
  // This read `now <= validTo`, so for the one instant at `validTo` the page
  // reported live authority while the gate was already denying every call
  // carrying its consequence.
  //
  // Both assertions are at the boundary itself. A pair at `validTo - 1s` and
  // `validTo + 1s` passes under the inclusive comparison and the exclusive one
  // alike, so it would have let this ship — which is how it did.
  it("is false at validTo itself, and true the millisecond before", () => {
    const to = "2026-09-16T23:59:59.999Z";
    const at = Date.parse(to);
    expect(isEffective(row({ validTo: to }), new Date(at))).toBe(false);
    expect(isEffective(row({ validTo: to }), new Date(at - 1))).toBe(true);
  });

  // The other end of the same window, for the same reason: enforcement's lower
  // bound is `lte(m.validFrom, args.at)`, so the first instant is inside.
  it("is true at validFrom itself, and false the millisecond before", () => {
    const from = "2026-09-17T00:00:00.000Z";
    const at = Date.parse(from);
    expect(isEffective(row({ validFrom: from }), new Date(at))).toBe(true);
    expect(isEffective(row({ validFrom: from }), new Date(at - 1))).toBe(false);
  });
});

describe("isChangeable", () => {
  const at = new Date("2026-09-16T12:00:00.000Z");
  const row = (over: Parameters<typeof mandateRow>[0]) => mandateRow(over);

  it("is an active mandate whose validTo has not elapsed", () => {
    expect(isChangeable(row({}), at)).toBe(true);
  });

  it.each([["draft"], ["revoked"], ["expired"]] as const)(
    "%s cannot be changed, since the handler takes an active mandate alone (negative)",
    (status) => {
      expect(isChangeable(row({ status }), at)).toBe(false);
    },
  );

  // The difference from `isEffective`, and the whole reason this exists. A
  // granted mandate whose window has not opened is the one an operator most
  // needs to correct, and `update_mandate_limits` accepts it: the handler tests
  // active status and an unelapsed validTo, never validFrom. Gating the app's
  // only limit-change control on `isEffective` hid it for exactly these rows.
  it("is true before validFrom, where isEffective is false", () => {
    const upcoming = row({
      validFrom: "2026-09-17T00:00:00.000Z",
      validTo: "2026-12-31T00:00:00.000Z",
    });
    expect(isChangeable(upcoming, at)).toBe(true);
    expect(isEffective(upcoming, at)).toBe(false);
  });

  // The bound it does share with enforcement, at the instant itself: the
  // handler refuses on `validTo <= now`, so the last changeable instant is the
  // millisecond before. A pair a second either side would pass under an
  // inclusive comparison too, which is how the same defect shipped in
  // `isEffective`.
  it("is false at validTo itself, and true the millisecond before", () => {
    const to = "2026-09-16T23:59:59.999Z";
    const instant = Date.parse(to);
    expect(isChangeable(row({ validTo: to }), new Date(instant))).toBe(false);
    expect(isChangeable(row({ validTo: to }), new Date(instant - 1))).toBe(
      true,
    );
  });
});

describe("isUpcoming", () => {
  const at = new Date("2026-09-16T12:00:00.000Z");
  const ahead = "2026-09-17T00:00:00.000Z";

  it("is a granted mandate whose start date is still ahead", () => {
    expect(isUpcoming(mandateRow({ validFrom: ahead }), at)).toBe(true);
  });

  it("is false once the window has opened, on the instant it opens", () => {
    expect(isUpcoming(mandateRow({ validFrom: ahead }), new Date(ahead))).toBe(
      false,
    );
    expect(isUpcoming(mandateRow({}), at)).toBe(false);
  });

  // The two predicates partition an active mandate's timeline at `validFrom`
  // with no gap and no overlap. A gap is an instant the page can say nothing
  // about; an overlap is an instant it says two contradictory things about.
  it("hands over to isEffective at validFrom exactly", () => {
    const start = Date.parse(ahead);
    const row = mandateRow({ validFrom: ahead });
    expect([
      isUpcoming(row, new Date(start - 1)),
      isEffective(row, new Date(start - 1)),
    ]).toEqual([true, false]);
    expect([
      isUpcoming(row, new Date(start)),
      isEffective(row, new Date(start)),
    ]).toEqual([false, true]);
  });

  // The page uses this to say something the status column contradicts
  // otherwise, so it must not fire for a row that is merely not effective: a
  // draft dated in the future is a request nobody has granted, and calling it
  // an upcoming grant would assert authority that does not exist.
  it.each([["draft"], ["revoked"], ["expired"]] as const)(
    "%s is never upcoming, however its window is dated (negative)",
    (status) => {
      expect(isUpcoming(mandateRow({ status, validFrom: ahead }), at)).toBe(
        false,
      );
    },
  );

  it("and an expired grant is not upcoming though its window is shut", () => {
    expect(
      isUpcoming(
        mandateRow({ status: "expired", validTo: "2026-09-01T00:00:00.000Z" }),
        at,
      ),
    ).toBe(false);
  });
});

describe("blindSpotOf", () => {
  const listOf = (rows: number, truncatedAt: number | null = null) => {
    const read = mandateList(
      Array.from({ length: rows }, () => mandateRow()),
      truncatedAt,
    );
    if (!read.ok) throw new Error("builder answered a failure");
    return read.value;
  };

  it("is null for an accountable reader answered the whole set", () => {
    expect(blindSpotOf(listOf(0), "owner")).toBeNull();
    expect(blindSpotOf(listOf(3), "compliance")).toBeNull();
  });

  it.each([["member"], ["viewer"]] as const)(
    "is reader_scope for a %s, whose answer is narrowed silently",
    (role) => {
      expect(blindSpotOf(listOf(0), role)).toBe("reader_scope");
    },
  );

  it("is truncated when the read stopped at the bound it asked for", () => {
    expect(blindSpotOf(listOf(100, 100), "owner")).toBe("truncated");
  });

  // A narrowed reader is the stronger statement: the rows themselves are not
  // the whole set, so naming the page bound would understate it.
  it("names the reader's scope first when both hold", () => {
    expect(blindSpotOf(listOf(100, 100), "member")).toBe("reader_scope");
  });

  // The mirrored set, pinned over the whole enum. It tracks
  // ACCOUNTABLE_ORG_ROLES in packages/handlers/src/_mandate.ts, which the app
  // may not import, so this is where a drift is caught.
  it("treats exactly the four accountable org roles as complete readers", () => {
    const every: readonly OrgRole[] = [
      "owner",
      "admin",
      "member",
      "billing",
      "compliance",
      "viewer",
    ];
    expect(
      every.filter((role) => blindSpotOf(listOf(0), role) === null),
    ).toEqual(["owner", "admin", "billing", "compliance"]);
  });
});

// Every bound the request form applies is a copy of a rule in
// packages/oxagen/src/mandates/schemas.ts, which §2 keeps out of the app. A
// copy drifts in silence, and a bound tighter than its rule refuses — or, for a
// maxLength, truncates — a request the platform would have taken. These pin
// each copy against the rule it was taken from, quoted in the assertion.
describe("the contract bounds this app mirrors", () => {
  /** `consequenceTagSchema`: 2 to 64 characters. Quoted, not imported, so the
   * assertions below read as the rule rather than as the copy of it. */
  const CONSEQUENCE_TAG_MAX = 64;

  /** `mandateSchema.consequenceTags`: `.min(1).max(16)`. Quoted for the same
   * reason, and it is the app's copy of the rule that has to hold: the derived
   * `CONSEQUENCE_OTHER_MAX` below is imported, so a change to either ceiling in
   * the source shows up there as a length this file no longer agrees with. */
  const MAX_CONSEQUENCE_TAGS = 16;

  describe("CONSEQUENCE_TAG mirrors consequenceTagSchema", () => {
    // /^[a-z][a-z0-9_]{1,63}$/ — snake_case, 2 to 64 characters.
    it.each([
      ["ab"],
      ["moves_money"],
      ["ships_code"],
      ["a1_b2"],
      ["a".repeat(CONSEQUENCE_TAG_MAX)],
    ])("admits %s", (tag) => {
      expect(CONSEQUENCE_TAG.test(tag)).toBe(true);
    });

    it.each([
      ["a"],
      ["a".repeat(CONSEQUENCE_TAG_MAX + 1)],
      ["Moves_money"],
      ["1moves"],
      ["_moves"],
      ["moves-money"],
      ["moves money"],
      [""],
    ])("refuses %s (negative)", (tag) => {
      expect(CONSEQUENCE_TAG.test(tag)).toBe(false);
    });

    it("puts its ceiling at 64, the schema's", () => {
      expect(CONSEQUENCE_TAG_MAX).toBe(64);
      expect(CONSEQUENCE_TAG.test("a".repeat(64))).toBe(true);
      expect(CONSEQUENCE_TAG.test("a".repeat(65))).toBe(false);
    });
  });

  describe("MEASURE_VALUE mirrors measureValueSchema", () => {
    // /^(0|[1-9][0-9]{0,29})$/ — an integer string of up to thirty digits.
    it.each([["0"], ["1"], ["500"], ["1000000000"], ["9".repeat(30)]])(
      "admits %s",
      (value) => {
        expect(MEASURE_VALUE.test(value)).toBe(true);
      },
    );

    it.each([["9".repeat(31)], ["007"], ["-1"], ["1.5"], ["1,000"], [""]])(
      "refuses %s (negative)",
      (value) => {
        expect(MEASURE_VALUE.test(value)).toBe(false);
      },
    );

    // The finding this pins: calls were held to nine digits while every other
    // limit took thirty, so a cap of a billion calls was refused before the
    // kernel although the ledger would have held it.
    it("admits a figure past nine digits, which the old calls rule refused", () => {
      expect(MEASURE_VALUE.test("1000000000")).toBe(true);
      expect(/^\d{1,9}$/.test("1000000000")).toBe(false);
    });
  });

  describe("MEASURE_NAME mirrors measureNameSchema", () => {
    // /^[a-z][a-z0-9_]{0,63}$/ — snake_case, 1 to 64 characters.
    it.each([["r"], ["rows"], ["rows_read_2"], [`a${"b".repeat(63)}`]])(
      "admits %s",
      (name) => {
        expect(MEASURE_NAME.test(name)).toBe(true);
      },
    );

    it.each([
      [""],
      ["Rows"],
      ["rows-read"],
      ["rows read"],
      ["2rows"],
      [`a${"b".repeat(64)}`],
    ])("refuses %s (negative)", (name) => {
      expect(MEASURE_NAME.test(name)).toBe(false);
    });
  });

  describe("MANDATE_APPROVER mirrors mandateApproverSchema", () => {
    // role:<Owner|Admin|Compliance|Billing> or user:<usr_…>, either casing.
    it.each([
      ["role:Owner"],
      ["role:admin"],
      ["role:Compliance"],
      ["ROLE:BILLING"],
      ["user:usr_priyanatarajan"],
    ])("admits %s", (entry) => {
      expect(MANDATE_APPROVER.test(entry)).toBe(true);
    });

    it.each([
      ["role:Member"],
      ["role:Viewer"],
      ["priya"],
      ["user:priya"],
      [""],
    ])("refuses %s (negative)", (entry) => {
      expect(MANDATE_APPROVER.test(entry)).toBe(false);
    });
  });

  it("carries the array and length ceilings the mandate shape states", () => {
    expect(MEASURE_NAME_MAX).toBe(64); // measureNameSchema, 64 characters
    expect(UNIT_MAX).toBe(32); // currencyOrUnit.max(32)
    expect(PURPOSE_MAX).toBe(2000); // purpose.max(2000)
  });

  // The field that collects tags the boxes do not offer must hold the longest
  // legal set, or the browser truncates it and the truncated set is still
  // syntactically valid — requested, granted, and covering nothing.
  it("sizes the free consequence field for every tag at its ceiling", () => {
    const longest = Array.from({ length: MAX_CONSEQUENCE_TAGS }, () =>
      "a".repeat(CONSEQUENCE_TAG_MAX),
    ).join(", ");
    expect(longest.length).toBe(CONSEQUENCE_OTHER_MAX);
    expect(CONSEQUENCE_OTHER_MAX).toBeGreaterThan(256);
    for (const tag of longest.split(", ")) {
      expect(CONSEQUENCE_TAG.test(tag)).toBe(true);
    }
  });
});

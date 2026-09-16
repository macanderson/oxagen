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
  isEffective,
  isUpcoming,
  MAX_CONSEQUENCE_TAGS,
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

  it("is true on the last instant and false after it", () => {
    const to = "2026-09-16T23:59:59.999Z";
    expect(isEffective(row({ validTo: to }), new Date(to))).toBe(true);
    expect(
      isEffective(row({ validTo: to }), new Date("2026-09-17T00:00:00.000Z")),
    ).toBe(false);
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

  it("carries the array and length ceilings the mandate shape states", () => {
    expect(MAX_CONSEQUENCE_TAGS).toBe(16); // consequenceTags.max(16)
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

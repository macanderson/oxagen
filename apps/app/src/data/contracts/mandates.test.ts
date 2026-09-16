// `readsEveryMandate` (#2957): which readers a mandate surface may tell that no
// authority exists. `list_mandates` answers a non-accountable reader a
// successful list narrowed to the agents they created (`readerFilter`,
// packages/handlers/src/_mandate.ts), so an empty answer to such a reader is
// not evidence of an empty ledger and no surface may present it as one.
import { describe, expect, it } from "vitest";
import type { OrgRole } from "./common";
import { mandateList, mandateRow } from "@/test/mandate-views";
import { blindSpotOf, isEffective } from "./mandates";

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

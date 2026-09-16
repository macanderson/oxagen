// `readsEveryMandate` (#2957): which readers a mandate surface may tell that no
// authority exists. `list_mandates` answers a non-accountable reader a
// successful list narrowed to the agents they created (`readerFilter`,
// packages/handlers/src/_mandate.ts), so an empty answer to such a reader is
// not evidence of an empty ledger and no surface may present it as one.
import { describe, expect, it } from "vitest";
import type { OrgRole } from "./common";
import { mandateRow } from "@/test/mandate-views";
import { isEffective, readsEveryMandate } from "./mandates";

describe("readsEveryMandate", () => {
  it.each([["owner"], ["admin"], ["billing"], ["compliance"]] as const)(
    "%s is answered every mandate, so an empty answer is an empty ledger",
    (role) => {
      expect(readsEveryMandate(role)).toBe(true);
    },
  );

  it.each([["member"], ["viewer"]] as const)(
    "%s is answered a narrowed list, so an empty answer proves nothing (negative)",
    (role) => {
      expect(readsEveryMandate(role)).toBe(false);
    },
  );

  it("mirrors ACCOUNTABLE_ORG_ROLES and admits no role outside the enum", () => {
    const every: readonly OrgRole[] = [
      "owner",
      "admin",
      "member",
      "billing",
      "compliance",
      "viewer",
    ];
    expect(every.filter(readsEveryMandate)).toEqual([
      "owner",
      "admin",
      "billing",
      "compliance",
    ]);
  });
});

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

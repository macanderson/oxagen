import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { mandateGet } from "./mandate.get";
import { mandateList } from "./mandate.list";

describe("get_mandate contract", () => {
  it("is a console read with the same readers as list_mandates", () => {
    expect(getCapability("get_mandate")).toBe(mandateGet);
    expect(mandateGet.mutates).toBe(false);
    expect(mandateGet.noBillingGate).toBe(true);
    expect(mandateGet.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    });
    expect(mandateGet.defaultRoles.workspace).toEqual({
      Owner: "allow",
      Member: "allow",
    });
  });

  // #3138 (ADR-107): the mandate a list row links to must be readable by the
  // same caller who could see it in the list, or `readerFilter`'s
  // creator-narrowing (packages/handlers/src/_mandate.ts), already wired
  // into this handler, stays unreachable for exactly the reader list_mandates
  // now admits.
  it("admits exactly the roles list_mandates admits", () => {
    expect(mandateGet.defaultRoles.org).toEqual(mandateList.defaultRoles.org);
    expect(mandateGet.defaultRoles.workspace).toEqual(
      mandateList.defaultRoles.workspace,
    );
  });

  it("takes a mandate public id and a bounded ledger page", () => {
    expect(
      mandateGet.input.parse({ mandateId: "mnd_0123456789abcdefghjkmn" }),
    ).toEqual({
      mandateId: "mnd_0123456789abcdefghjkmn",
      ledgerLimit: 100,
    });
    expect(
      mandateGet.input.safeParse({ mandateId: "mnd_x", ledgerLimit: 501 })
        .success,
    ).toBe(false);
    expect(
      mandateGet.input.safeParse({
        mandateId: "0195b7c8-1e6e-7c3a-9f0e-0a1b2c3d4e5f",
      }).success,
    ).toBe(false);
  });

  it("answers with the mandate and its ledger rows, values as integer strings", () => {
    const row = {
      id: "0195b7c8-1e6e-7c3a-9f0e-0a1b2c3d4e5f",
      toolCallId: "0195b7c8-1e6e-7c3a-9f0e-0a1b2c3d4e60",
      kind: "settle",
      measure: "amount",
      measureKind: "money",
      value: "250000000",
      unitOrCurrency: "USD",
      externalEffectId: "pi_3Q",
      periodKey: "2026-09",
      balanceAfter: "1750000000",
      at: "2026-09-14T10:00:00.000Z",
    };
    const ledger = mandateGet.output.shape.ledger;
    expect(ledger.parse([row])).toHaveLength(1);
    expect(ledger.safeParse([{ ...row, value: 250000000 }]).success).toBe(
      false,
    );
    expect(ledger.safeParse([{ ...row, kind: "refund" }]).success).toBe(false);
  });
});

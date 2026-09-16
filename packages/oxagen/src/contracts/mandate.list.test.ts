import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { mandateList } from "./mandate.list";

describe("list_mandates contract", () => {
  it("is a console read: scoped, non-mutating, unmetered, for the accountable office by default", () => {
    expect(getCapability("list_mandates")).toBe(mandateList);
    expect(mandateList.scoped).toBe(true);
    expect(mandateList.mutates).toBe(false);
    expect(mandateList.noBillingGate).toBe(true);
    expect(mandateList.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    });
  });

  it("defaults the page size and narrows by agent or status", () => {
    expect(mandateList.input.parse({})).toEqual({ limit: 50 });
    expect(
      mandateList.input.parse({
        agentId: "agt_0123456789abcdefghjkmn",
        status: "active",
        limit: 5,
      }),
    ).toEqual({
      agentId: "agt_0123456789abcdefghjkmn",
      status: "active",
      limit: 5,
    });
    expect(mandateList.input.safeParse({ status: "suspended" }).success).toBe(
      false,
    );
    expect(mandateList.input.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      mandateList.input.safeParse({ agentId: "invoice-bot" }).success,
    ).toBe(false);
  });
});

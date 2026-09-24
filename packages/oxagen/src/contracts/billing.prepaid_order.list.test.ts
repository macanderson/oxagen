import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { getSurfaces } from "../types";
import { billingPrepaidOrderList } from "./billing.prepaid_order.list";

describe("list_prepaid_orders contract", () => {
  it("is registered under its verb-first name", () => {
    expect(getCapability("list_prepaid_orders")).toBe(billingPrepaidOrderList);
  });

  it("is a scoped console read on api and mcp that never meets the billing gate", () => {
    expect(getSurfaces(billingPrepaidOrderList)).toEqual(["api", "mcp"]);
    expect(billingPrepaidOrderList.scoped).toBe(true);
    expect(billingPrepaidOrderList.noBillingGate).toBe(true);
    expect(billingPrepaidOrderList.mutates).toBe(false);
    expect(billingPrepaidOrderList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Billing: "allow" },
      workspace: {},
    });
  });

  it("pages 1 to 100 rows, 50 by default", () => {
    expect(billingPrepaidOrderList.input.parse({})).toEqual({ limit: 50 });
    expect(billingPrepaidOrderList.input.safeParse({ limit: 0 }).success).toBe(
      false,
    );
    expect(
      billingPrepaidOrderList.input.safeParse({ limit: 101 }).success,
    ).toBe(false);
  });

  it("never lists a draft", () => {
    const item = {
      orderId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
      status: "open",
      agreementRef: null,
      poNumber: null,
      currency: "usd",
      lines: [],
      totalMicros: "0",
      grantOn: "paid",
      unitsGrantedAt: null,
      creditsGrantedAt: null,
      paidAt: null,
      createdAt: "2026-09-23T00:00:00.000Z",
      invoice: null,
    };
    const parse = (status: string) =>
      billingPrepaidOrderList.output.safeParse({
        items: [{ ...item, status }],
        nextCursor: null,
      }).success;
    expect(parse("open")).toBe(true);
    expect(parse("draft")).toBe(false);
  });
});

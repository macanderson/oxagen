import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { billingStatementExport } from "./billing.statement.export";
import {
  billingStatementGet,
  statementBucketSchema,
  statementInvoiceSchema,
  STATEMENT_TOP_DEFAULT,
} from "./billing.statement.get";

describe("get_billing_statement contract", () => {
  it("are registered under their verb-first names", () => {
    expect(getCapability("get_billing_statement")).toBe(billingStatementGet);
    expect(getCapability("export_billing_statement")).toBe(
      billingStatementExport,
    );
  });
  it.each([billingStatementGet, billingStatementExport])(
    "$name is a billing read: mutates false, noBillingGate, scoped, Owner/Admin/Billing, api+mcp+cli",
    (cap) => {
      expect(cap.mutates).toBe(false);
      expect(cap.noBillingGate).toBe(true);
      expect(cap.scoped).toBe(true);
      expect(cap.defaultEffect).toBe("deny");
      expect(cap.defaultRoles).toEqual({
        org: { Owner: "allow", Admin: "allow", Billing: "allow" },
        workspace: {},
      });
      expect(cap.surfaces).toEqual(["api", "mcp", "cli"]);
      expect(cap.layers).not.toContain("e2e");
    },
  );
  it("takes a calendar period by anchor or a custom range, and defaults the breakdown size", () => {
    expect(
      billingStatementGet.input.parse({
        period: "month",
        anchor: "2026-09-01",
      }),
    ).toEqual({
      period: "month",
      anchor: "2026-09-01",
      top: STATEMENT_TOP_DEFAULT,
    });
    expect(
      billingStatementGet.input.safeParse({
        period: "custom",
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-10T00:00:00+02:00",
      }).success,
    ).toBe(true);
    for (const bad of [
      { period: "fortnight", anchor: "2026-09-01" },
      { period: "month", anchor: "1 Sep 2026" },
      { period: "custom", from: "yesterday", to: "2026-09-10T00:00:00Z" },
      { period: "month", anchor: "2026-09-01", top: 0 },
      { period: "month", anchor: "2026-09-01", top: 101 },
      { period: "month", anchor: "2026-09-01", workspaceId: "w" },
    ])
      expect(
        billingStatementGet.input.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });
  it("carries money as micro-unit strings and names each bucket's reconciliation", () => {
    const invoice = {
      publicId: "inv_1",
      number: null,
      status: "open",
      kind: "prepaid_order",
      amountDueMicros: "10000",
      amountPaidMicros: "0",
      amountRemainingMicros: "10000",
      currency: "usd",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      issuedAt: "2026-09-01T00:00:00.000Z",
      dueAt: null,
      paidAt: null,
      hostedInvoiceUrl: null,
      invoicePdfUrl: null,
    };
    expect(statementInvoiceSchema.safeParse(invoice).success).toBe(true);
    expect(
      statementInvoiceSchema.safeParse({ ...invoice, amountDueMicros: 10000 })
        .success,
    ).toBe(false);
    expect(
      statementInvoiceSchema.safeParse({ ...invoice, status: "draft" }).success,
    ).toBe(false);
    expect(statementBucketSchema.shape.reconciliation.options).toEqual([
      "matched",
      "unitemised",
      "mismatch",
    ]);
  });
});

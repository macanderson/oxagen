import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { getSurfaces } from "../types";
import { billingOrgTermsSet } from "./billing.org_terms.set";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";

describe("set_org_billing_terms contract", () => {
  it("is registered under its verb-first name", () => {
    expect(getCapability("set_org_billing_terms")).toBe(billingOrgTermsSet);
  });

  it("is the platform-operator write: platformOnly, unscoped, no billing gate", () => {
    expect(billingOrgTermsSet.platformOnly).toBe(true);
    expect(billingOrgTermsSet.mutates).toBe(true);
    expect(billingOrgTermsSet.scoped).toBe(false);
    expect(billingOrgTermsSet.noBillingGate).toBe(true);
    expect(billingOrgTermsSet.sensitivity).toBe("high");
  });

  it("is on no surface and no role grants it", () => {
    expect(getSurfaces(billingOrgTermsSet)).toEqual([]);
    expect(billingOrgTermsSet.layers).toEqual(["schema", "unit", "docs"]);
    expect(billingOrgTermsSet.defaultEffect).toBe("deny");
    expect(billingOrgTermsSet.defaultRoles).toEqual({ org: {}, workspace: {} });
  });

  it("takes the target org by id, since the call carries no tenant", () => {
    expect(
      billingOrgTermsSet.input.parse({
        orgId: ORG,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 100_000,
      }),
    ).toEqual({
      orgId: ORG,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 100_000,
    });
    expect(
      billingOrgTermsSet.input.safeParse({
        orgId: "acme",
        approvedForInvoiceBilling: true,
        invoiceGauMax: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts a whole-number ceiling in 1…100,000,000 and refuses anything else", () => {
    for (const invoiceGauMax of [1, 100_000, 100_000_000]) {
      expect(
        billingOrgTermsSet.input.safeParse({
          orgId: ORG,
          approvedForInvoiceBilling: false,
          invoiceGauMax,
        }).success,
      ).toBe(true);
    }
    for (const invoiceGauMax of [0, -1, 100_000_001, 2.5]) {
      expect(
        billingOrgTermsSet.input.safeParse({
          orgId: ORG,
          approvedForInvoiceBilling: false,
          invoiceGauMax,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses an unknown input key", () => {
    expect(
      billingOrgTermsSet.input.safeParse({
        orgId: ORG,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 1,
        autoTopupBlocks: 2,
      }).success,
    ).toBe(false);
  });

  it("returns the stored row, with the assistant spend cap", () => {
    const row = {
      orgId: ORG,
      approvedForInvoiceBilling: false,
      invoiceGauMax: 250_000,
      assistantSpendCapCents: null,
    };
    expect(billingOrgTermsSet.output.parse(row)).toEqual(row);
    expect(
      billingOrgTermsSet.output.safeParse({
        ...row,
        assistantSpendCapCents: undefined,
      }).success,
    ).toBe(false);
  });

  it("sets the assistant spend cap on its own, or beside the billing mode", () => {
    for (const assistantSpendCapCents of [0, 600_000, null]) {
      expect(
        billingOrgTermsSet.input.safeParse({
          orgId: ORG,
          assistantSpendCapCents,
        }).success,
      ).toBe(true);
    }
    expect(
      billingOrgTermsSet.input.safeParse({
        orgId: ORG,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 1,
        assistantSpendCapCents: 500,
      }).success,
    ).toBe(true);
    for (const assistantSpendCapCents of [-1, 2.5]) {
      expect(
        billingOrgTermsSet.input.safeParse({
          orgId: ORG,
          assistantSpendCapCents,
        }).success,
      ).toBe(false);
    }
  });

  it("sets the billing mode's two fields together, and refuses a call that sets nothing", () => {
    expect(
      billingOrgTermsSet.input.safeParse({
        orgId: ORG,
        approvedForInvoiceBilling: true,
      }).success,
    ).toBe(false);
    expect(
      billingOrgTermsSet.input.safeParse({ orgId: ORG, invoiceGauMax: 10 })
        .success,
    ).toBe(false);
    expect(billingOrgTermsSet.input.safeParse({ orgId: ORG }).success).toBe(
      false,
    );
  });
});

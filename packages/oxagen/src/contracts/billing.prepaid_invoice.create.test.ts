import { afterEach, describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { getSurfaces, type CapabilityContext } from "../types";
import { clearHandlersForTests, invoke, registerHandler } from "../kernel";
import { createPlatformOperatorContext } from "../platform-operator";
import { billingPrepaidInvoiceCreate } from "./billing.prepaid_invoice.create";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";

const valid = {
  orgId: ORG,
  licence: {
    amountCents: 12_000_000,
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2027-10-01T00:00:00.000Z",
  },
  gau: { quantity: 2_000_000 },
  creditsCents: 500_000,
};

const operatorCtx = (): CapabilityContext => ({
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req-operator",
  surface: "runner",
  messageId: null,
});

describe("create_prepaid_invoice contract", () => {
  afterEach(() => clearHandlersForTests());

  it("is registered under its verb-first name", () => {
    expect(getCapability("create_prepaid_invoice")).toBe(
      billingPrepaidInvoiceCreate,
    );
  });

  it("is a platform-operator write on no surface that no role grants", () => {
    expect(billingPrepaidInvoiceCreate.platformOnly).toBe(true);
    expect(billingPrepaidInvoiceCreate.scoped).toBe(false);
    expect(billingPrepaidInvoiceCreate.noBillingGate).toBe(true);
    expect(billingPrepaidInvoiceCreate.sensitivity).toBe("high");
    expect(getSurfaces(billingPrepaidInvoiceCreate)).toEqual([]);
    expect(billingPrepaidInvoiceCreate.defaultEffect).toBe("deny");
    expect(billingPrepaidInvoiceCreate.defaultRoles).toEqual({
      org: {},
      workspace: {},
    });
  });

  it("the kernel refuses it without a minted binding, before the handler runs", async () => {
    let ran = false;
    registerHandler("create_prepaid_invoice", async () => async () => {
      ran = true;
      throw new Error("unreachable");
    });
    await expect(
      invoke("create_prepaid_invoice", valid, operatorCtx()),
    ).rejects.toMatchObject({
      code: "authz_denied",
    });
    // A copy of a minted binding is not the binding.
    const minted = createPlatformOperatorContext({ requestId: "r" });
    await expect(
      invoke("create_prepaid_invoice", valid, {
        ...operatorCtx(),
        platformOperator: { ...minted },
      }),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });

  it("defaults the payment term to 30 days and the grant to payment", () => {
    expect(billingPrepaidInvoiceCreate.input.parse(valid)).toMatchObject({
      daysUntilDue: 30,
      grantOn: "paid",
    });
  });

  it("takes whole cents, a 0 to 365 day term, a rate as digits, and a nullable cap", () => {
    for (const over of [
      { assistantSpendCapCents: null },
      { assistantSpendCapCents: 600_000 },
      { gau: { quantity: 10, ratePerGauMicros: "3000" } },
      { daysUntilDue: 0 },
      { grantOn: "issue" },
      { orderId: "0192d4a8-7c1e-7a00-8000-0000000000d1" },
    ]) {
      expect(
        billingPrepaidInvoiceCreate.input.safeParse({ ...valid, ...over })
          .success,
      ).toBe(true);
    }
    for (const over of [
      { creditsCents: 1.5 },
      { creditsCents: -1 },
      { licence: { ...valid.licence, amountCents: 0 } },
      { gau: { quantity: 0 } },
      { gau: { quantity: 10, ratePerGauMicros: "0.3" } },
      { daysUntilDue: 366 },
      { assistantSpendCapCents: -1 },
      { poNumber: "x".repeat(141) },
      { orderId: "order-1" },
      { unknown: true },
    ]) {
      expect(
        billingPrepaidInvoiceCreate.input.safeParse({ ...valid, ...over })
          .success,
      ).toBe(false);
    }
  });
});

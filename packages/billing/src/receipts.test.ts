/**
 * Unit tests for sendPaymentReceipt (packages/billing/src/receipts.ts).
 *
 * Mocks at the seam — no live Postgres, no email transport:
 *  - resolveOrgFromInvoice (./dunning) is spied so we control org resolution.
 *  - @oxagen/database.withSystemDb is a passthrough that hands the handler a
 *    mock tx exposing query.organizations.findFirst.
 *  - @oxagen/notifications is spied so we assert the template INPUT mapping and
 *    the notifyOrgManagers call, without rendering or sending a real email.
 *
 * Scenarios:
 *  1. Non-zero invoice → resolves org, maps template input, sends via notifyOrgManagers.
 *  2. Description falls back to the invoice number when there are no line items.
 *  3. receiptUrl falls back invoicePdfUrl → app URL when no hosted URL.
 *  4. Zero-amount invoice → skipped (no template, no send).
 *  5. Unresolvable org → no send.
 *  6. Org name falls back to "your organization" when the org row is missing.
 *  7. A notifyOrgManagers failure is swallowed (never throws / fails the webhook).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingInvoice } from "./provider";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before the import of the module under test.
// ---------------------------------------------------------------------------

const resolveOrgFromInvoiceMock =
  vi.fn<(tx: unknown, invoice: BillingInvoice) => Promise<string | null>>();
vi.mock("./dunning", () => ({
  resolveOrgFromInvoice: resolveOrgFromInvoiceMock,
}));

const notifyOrgManagersMock = vi.fn().mockResolvedValue(undefined);
const paymentReceiptTemplateMock = vi.fn(() => ({
  subject: "Payment receipt for Acme Inc",
  text: "receipt text",
  html: "<html>receipt</html>",
}));
vi.mock("@oxagen/notifications", () => ({
  notifyOrgManagers: notifyOrgManagersMock,
  paymentReceiptTemplate: paymentReceiptTemplateMock,
}));

// Mock tx: only the organizations lookup receipts.ts performs.
const organizationsFindFirstMock = vi
  .fn()
  .mockResolvedValue({ name: "Acme Inc" });
const mockTx = {
  query: { organizations: { findFirst: organizationsFindFirstMock } },
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(mockTx),
  };
});

// Import after mocks.
const { sendPaymentReceipt } = await import("./receipts");

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<BillingInvoice> = {}): BillingInvoice {
  return {
    id: "in_test_001",
    providerInvoiceId: "in_test_001",
    number: "INV-001",
    status: "paid",
    amountDueCents: 2000,
    amountPaidCents: 2000,
    amountRemainingCents: 0,
    currency: "usd",
    periodStart: new Date(),
    periodEnd: new Date(),
    dueAt: null,
    paidAt: new Date(),
    hostedInvoiceUrl: "https://stripe.example/receipt/in_test_001",
    invoicePdfUrl: "https://stripe.example/pdf/in_test_001",
    subscriptionId: "sub_test_001",
    orgId: "org-abc",
    billingReason: "subscription_cycle",
    lineItems: [
      {
        description: "Pro plan",
        quantity: 1,
        unitAmountCents: 2000,
        totalCents: 2000,
        metric: null,
        metadata: {},
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendPaymentReceipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrgFromInvoiceMock.mockResolvedValue("org-abc");
    organizationsFindFirstMock.mockResolvedValue({ name: "Acme Inc" });
    notifyOrgManagersMock.mockResolvedValue(undefined);
  });

  it("resolves the org and maps the template input, then sends via notifyOrgManagers", async () => {
    const invoice = makeInvoice();

    await sendPaymentReceipt(invoice);

    expect(resolveOrgFromInvoiceMock).toHaveBeenCalledWith(mockTx, invoice);
    // Template input maps from the paid amount, the line-item description, and
    // the hosted receipt URL.
    expect(paymentReceiptTemplateMock).toHaveBeenCalledWith({
      orgName: "Acme Inc",
      amountCents: 2000,
      description: "Pro plan",
      receiptUrl: "https://stripe.example/receipt/in_test_001",
    });
    expect(notifyOrgManagersMock).toHaveBeenCalledOnce();
    expect(notifyOrgManagersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-abc",
        kind: "system",
        title: "Payment receipt for Acme Inc",
        emailHtml: "<html>receipt</html>",
        deepLink: "/settings/billing",
      }),
    );
  });

  it("description falls back to the invoice number when there are no line items", async () => {
    await sendPaymentReceipt(makeInvoice({ lineItems: [], number: "INV-042" }));

    expect(paymentReceiptTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Invoice INV-042" }),
    );
  });

  it("receiptUrl falls back to the PDF, then the app URL, when no hosted URL exists", async () => {
    await sendPaymentReceipt(
      makeInvoice({
        hostedInvoiceUrl: null,
        invoicePdfUrl: "https://stripe.example/pdf/x",
      }),
    );
    expect(paymentReceiptTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ receiptUrl: "https://stripe.example/pdf/x" }),
    );

    paymentReceiptTemplateMock.mockClear();

    await sendPaymentReceipt(
      makeInvoice({ hostedInvoiceUrl: null, invoicePdfUrl: null }),
    );
    expect(paymentReceiptTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptUrl: expect.stringContaining("/settings/billing"),
      }),
    );
  });

  it("skips zero-amount invoices — no template, no send", async () => {
    await sendPaymentReceipt(
      makeInvoice({ amountPaidCents: 0, amountDueCents: 0 }),
    );

    expect(resolveOrgFromInvoiceMock).not.toHaveBeenCalled();
    expect(paymentReceiptTemplateMock).not.toHaveBeenCalled();
    expect(notifyOrgManagersMock).not.toHaveBeenCalled();
  });

  it("does not send when the org cannot be resolved", async () => {
    resolveOrgFromInvoiceMock.mockResolvedValue(null);

    await sendPaymentReceipt(makeInvoice());

    expect(paymentReceiptTemplateMock).not.toHaveBeenCalled();
    expect(notifyOrgManagersMock).not.toHaveBeenCalled();
  });

  it("falls back to 'your organization' when the org row is missing", async () => {
    organizationsFindFirstMock.mockResolvedValue(undefined);

    await sendPaymentReceipt(makeInvoice());

    expect(paymentReceiptTemplateMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgName: "your organization" }),
    );
  });

  it("swallows a notifyOrgManagers failure — never throws (webhook must not fail)", async () => {
    notifyOrgManagersMock.mockRejectedValue(new Error("smtp down"));

    await expect(sendPaymentReceipt(makeInvoice())).resolves.toBeUndefined();
    expect(notifyOrgManagersMock).toHaveBeenCalledOnce();
  });
});

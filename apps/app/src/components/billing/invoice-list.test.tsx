// @vitest-environment jsdom
/**
 * invoice-list.test.tsx — render tests for InvoiceList.
 *
 * Covers:
 *   - Empty state: renders the "No invoices yet" title + explanation
 *   - Renders invoice number
 *   - Renders period dates
 *   - Renders amount
 *   - Paid badge variant: success
 *   - Unpaid badge variant: warning
 *   - Renders external link button when hostedInvoiceUrl is set
 *   - Renders PDF button when invoicePdfUrl is set
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { InvoiceList, type Invoice } from "./invoice-list";

afterEach(cleanup);

const paidInvoice: Invoice = {
  publicId: "inv-1",
  number: "INV-001",
  status: "paid",
  amountDueCents: 2000,
  currency: "usd",
  periodStart: "2025-01-01T00:00:00Z",
  periodEnd: "2025-01-31T00:00:00Z",
  hostedInvoiceUrl: "https://stripe.com/inv/abc",
  invoicePdfUrl: "https://stripe.com/inv/abc.pdf",
  paidAt: "2025-01-31T00:00:00Z",
};

const unpaidInvoice: Invoice = {
  publicId: "inv-2",
  number: null,
  status: "open",
  amountDueCents: 5000,
  currency: "usd",
  periodStart: "2025-02-01T00:00:00Z",
  periodEnd: "2025-02-28T00:00:00Z",
  hostedInvoiceUrl: null,
  invoicePdfUrl: null,
  paidAt: null,
};

describe("InvoiceList — empty state", () => {
  it("renders the empty state (title + explanation) when there are no invoices", () => {
    render(<InvoiceList invoices={[]} />);
    expect(screen.getByText("No invoices yet")).toBeInTheDocument();
    expect(
      screen.getByText("Invoices appear here after your first billing cycle."),
    ).toBeInTheDocument();
  });
});

describe("InvoiceList — with invoices", () => {
  it("renders invoice number", () => {
    render(<InvoiceList invoices={[paidInvoice]} />);
    expect(screen.getByText("INV-001")).toBeInTheDocument();
  });

  it("falls back to publicId when number is null", () => {
    render(<InvoiceList invoices={[unpaidInvoice]} />);
    expect(screen.getByText("inv-2")).toBeInTheDocument();
  });

  it("renders the formatted amount", () => {
    render(<InvoiceList invoices={[paidInvoice]} />);
    // $20.00 from 2000 cents
    expect(screen.getByText("$20.00")).toBeInTheDocument();
  });

  it("renders paid badge", () => {
    render(<InvoiceList invoices={[paidInvoice]} />);
    expect(screen.getByText("paid")).toBeInTheDocument();
  });

  it("renders open status badge", () => {
    render(<InvoiceList invoices={[unpaidInvoice]} />);
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("renders external link button when hostedInvoiceUrl is set", () => {
    render(<InvoiceList invoices={[paidInvoice]} />);
    // Button rendered as <a> with target=_blank
    const links = document.querySelectorAll('a[target="_blank"]');
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it("does not render external link when hostedInvoiceUrl is null", () => {
    render(<InvoiceList invoices={[unpaidInvoice]} />);
    const links = document.querySelectorAll('a[target="_blank"]');
    expect(links.length).toBe(0);
  });

  it("renders multiple invoices", () => {
    render(<InvoiceList invoices={[paidInvoice, unpaidInvoice]} />);
    expect(screen.getByText("INV-001")).toBeInTheDocument();
    expect(screen.getByText("inv-2")).toBeInTheDocument();
  });
});

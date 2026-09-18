// invoicesInMonth (this-month.tsx): the invoices whose period touches the
// bucket month, a void one excluded. Boundary inclusion is
// `periodEnd >= period.start` and `periodStart < period.end`, so a row that
// starts exactly on the bucket's end date belongs to next month, not this
// one, and a row that ends exactly on the bucket's start date is this
// month's carry-in.
import { describe, expect, it } from "vitest";
import type { GauBucket, InvoiceRow } from "@/data/contracts/billing";
import { invoiceRow } from "./billing.builders";
import { invoicesInMonth } from "./this-month";

const PERIOD: GauBucket["period"] = {
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
};

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return invoiceRow({
    periodStart: PERIOD.start,
    periodEnd: PERIOD.end,
    ...overrides,
  });
}

describe("invoicesInMonth", () => {
  it("keeps a row whose period matches the bucket month", () => {
    const r = row();
    expect(invoicesInMonth([r], PERIOD)).toEqual([r]);
  });

  it("excludes a void row even though its period matches (negative)", () => {
    expect(invoicesInMonth([row({ status: "void" })], PERIOD)).toEqual([]);
  });

  it("keeps a row ending exactly on the bucket's start (the prior month's carry-in)", () => {
    const r = row({
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: PERIOD.start,
    });
    expect(invoicesInMonth([r], PERIOD)).toEqual([r]);
  });

  it("excludes a row that ends one millisecond before the bucket's start (negative)", () => {
    const r = row({
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-08-31T23:59:59.999Z",
    });
    expect(invoicesInMonth([r], PERIOD)).toEqual([]);
  });

  it("excludes a row starting exactly on the bucket's end (next month's, not this one) (negative)", () => {
    const r = row({
      periodStart: PERIOD.end,
      periodEnd: "2026-11-01T00:00:00.000Z",
    });
    expect(invoicesInMonth([r], PERIOD)).toEqual([]);
  });

  it("keeps a row starting one millisecond before the bucket's end", () => {
    const r = row({
      periodStart: "2026-09-30T23:59:59.999Z",
      periodEnd: "2026-10-31T00:00:00.000Z",
    });
    expect(invoicesInMonth([r], PERIOD)).toEqual([r]);
  });

  it("excludes a row entirely outside the bucket month (negative)", () => {
    const r = row({
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });
    expect(invoicesInMonth([r], PERIOD)).toEqual([]);
  });

  it("keeps only the rows in the month, in the order given", () => {
    const inMonth = row({ id: "inv_in" });
    const voided = row({ id: "inv_void", status: "void" });
    const outside = row({
      id: "inv_out",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
    });
    expect(invoicesInMonth([inMonth, voided, outside], PERIOD)).toEqual([
      inMonth,
    ]);
  });
});

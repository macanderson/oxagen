// The invoices This month rolls up: the rows of the newest page whose period
// touches the bucket month, a void one excluded (this-month.tsx). Its own
// module so that this-month.tsx is the production importer and the test is
// not the only one (knip --production --strict, INV-16).
import type { GauBucket, InvoiceRow } from "@/data/contracts/billing";

export function invoicesInMonth(
  items: readonly InvoiceRow[],
  period: GauBucket["period"],
): InvoiceRow[] {
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  return items.filter(
    (row) =>
      row.status !== "void" &&
      Date.parse(row.periodEnd) >= start &&
      Date.parse(row.periodStart) < end,
  );
}

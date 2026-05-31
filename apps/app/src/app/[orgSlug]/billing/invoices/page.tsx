import { desc, eq } from "drizzle-orm";
import { db, schema } from "@oxagen/database";
import type { InvoiceRow } from "@oxagen/database";
import { resolveOrg } from "@/lib/resolve-org";
import { InvoiceList } from "@/components/billing/invoice-list";

export default async function BillingInvoicesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const tenant = await resolveOrg(orgSlug);

  const invoiceRows = await (async () => {
    try {
      return await db()
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.orgId, tenant.id))
        .orderBy(desc(schema.invoices.createdAt))
        .limit(25);
    } catch {
      return [] as InvoiceRow[];
    }
  })();

  return (
    <div className="flex flex-col gap-6">
      <InvoiceList
        invoices={invoiceRows.map((i) => ({
          publicId: i.publicId,
          number: i.number,
          status: i.status,
          amountDueCents: i.amountDueCents,
          currency: i.currency,
          periodStart: i.periodStart.toISOString(),
          periodEnd: i.periodEnd.toISOString(),
          hostedInvoiceUrl: i.hostedInvoiceUrl,
          invoicePdfUrl: i.invoicePdfUrl,
          paidAt: i.paidAt?.toISOString() ?? null,
        }))}
      />
    </div>
  );
}

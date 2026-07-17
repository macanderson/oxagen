import { desc, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import type { InvoiceRow } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg } from "@/lib/resolve-org";

// Sentinel workspaceId for org-only routes (no workspace context). — OXA-1515
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
import { InvoiceList } from "@/components/billing/invoice-list";

export async function BillingInvoicesBody({ orgSlug }: { orgSlug: string }) {
  const tenant = await resolveOrg(orgSlug);

  // Org-only route — sentinel workspaceId. — OXA-1515
  const invoiceRows = await (async () => {
    try {
      return await runInTenantScope(
        { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
        () =>
          withTenantDb((tx) =>
            tx
              .select()
              .from(schema.invoices)
              .where(eq(schema.invoices.orgId, tenant.id))
              .orderBy(desc(schema.invoices.createdAt))
              .limit(25),
          ),
      );
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

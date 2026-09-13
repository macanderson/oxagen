import { Suspense } from "react";
import { LoadingRegion, TableSkeleton } from "@/components/loading";
import { BillingInvoicesBody } from "./invoices-body";

/**
 * Shell renders immediately; the invoice read streams in behind Suspense —
 * mirrors the subscription tab's page/body split.
 */
export default async function BillingInvoicesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <Suspense
      fallback={
        <LoadingRegion label="Loading invoices">
          <TableSkeleton />
        </LoadingRegion>
      }
    >
      <BillingInvoicesBody orgSlug={orgSlug} />
    </Suspense>
  );
}

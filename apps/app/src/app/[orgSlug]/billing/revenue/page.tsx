import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { BillingRevenueBody } from "./revenue-body";

/**
 * Shell renders immediately; the reseller reads (six invoke() calls, one of
 * which aggregates ClickHouse usage) stream in behind Suspense — mirrors the
 * subscription tab's page/body split.
 */
export default async function BillingRevenuePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-6" data-testid="revenue-loading">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
      }
    >
      <BillingRevenueBody orgSlug={orgSlug} />
    </Suspense>
  );
}

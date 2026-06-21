import {
  LoadingRegion,
  DetailSkeleton,
  CardGridSkeleton,
} from "@/components/loading";

export function BillingSubscriptionSkeleton() {
  return (
    <LoadingRegion label="Loading billing">
      <div className="flex flex-col gap-6">
        {/* Subscription summary (md:col-span-2) + credit sidebar (1 card) */}
        <div className="grid gap-6 md:grid-cols-3">
          <div className="md:col-span-2">
            <DetailSkeleton />
          </div>
          <div>
            <CardGridSkeleton count={1} />
          </div>
        </div>

        {/* Plan cards */}
        <CardGridSkeleton count={3} />

        {/* Payment methods */}
        <DetailSkeleton />
      </div>
    </LoadingRegion>
  );
}

import { Skeleton } from "@/components/ui/skeleton";

export default function BillingRevenueLoading() {
  return (
    <div className="flex flex-col gap-6" data-testid="revenue-loading">
      <Skeleton className="h-16 w-full rounded-lg" />
      <Skeleton className="h-64 w-full rounded-lg" />
      <Skeleton className="h-48 w-full rounded-lg" />
    </div>
  );
}

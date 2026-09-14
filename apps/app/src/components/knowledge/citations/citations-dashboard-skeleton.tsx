import { StatCardsSkeleton, TableSkeleton } from "@/components/loading";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading fallback for the Citations dashboard Suspense boundary — mirrors
 * the final layout (stat row, two chart blocks, then table/list sections) so
 * there's no layout shift when the real data streams in.
 */
export function CitationsDashboardSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-8">
      <StatCardsSkeleton count={4} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-[220px] w-full rounded-lg" />
        <Skeleton className="h-[220px] w-full rounded-lg" />
      </div>
      <Skeleton className="h-[280px] w-full rounded-lg" />
      <TableSkeleton rows={5} cols={5} />
      <TableSkeleton rows={5} cols={5} />
    </div>
  );
}

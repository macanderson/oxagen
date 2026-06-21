import { Skeleton } from "@/components/ui/skeleton";

export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-lg border p-4">
          <Skeleton className="h-6 w-12" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

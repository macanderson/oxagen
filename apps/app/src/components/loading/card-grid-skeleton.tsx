import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder for a responsive grid of cards — `count` cards, one to three per
 * row as the viewport widens. Wrap it in `LoadingRegion`; it is `aria-hidden`
 * on its own.
 */
export function CardGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div
      aria-hidden="true"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-lg border p-4">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

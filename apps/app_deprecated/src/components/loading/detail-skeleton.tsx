import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder for a detail pane: a heading line over three text lines of
 * decreasing width. Wrap it in `LoadingRegion`; it is `aria-hidden` on its own.
 */
export function DetailSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

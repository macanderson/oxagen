import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder for a table that is still loading: a header strip plus `rows`
 * body rows, each `cols` cells wide. Match the real table's shape so the page
 * doesn't jump when the data lands. Wrap it in `LoadingRegion` — it is
 * `aria-hidden` on its own.
 */
export function TableSkeleton({
  rows = 5,
  cols = 4,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className="w-full overflow-hidden rounded-lg border"
    >
      <div className="flex gap-4 border-b px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b px-4 py-4 last:border-b-0">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

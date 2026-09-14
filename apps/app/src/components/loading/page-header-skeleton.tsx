import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder for a `PageHeader`: icon, title, description, and — with
 * `withAction` — the primary button on the right. Wrap it in `LoadingRegion`;
 * it is `aria-hidden` on its own.
 */
export function PageHeaderSkeleton({
  withAction = false,
}: {
  withAction?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3" aria-hidden="true">
      <div className="flex items-start gap-3">
        <Skeleton className="mt-0.5 h-5 w-5 flex-shrink-0 rounded" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-64" />
        </div>
      </div>
      {withAction ? <Skeleton className="h-9 w-28 rounded-md" /> : null}
    </div>
  );
}

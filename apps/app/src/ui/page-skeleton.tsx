// The loading state: the page's shape in quiet blocks, announced once as busy.
import { useTranslations } from "next-intl";
import { cx } from "./cx";

export type SkeletonLayout = "table" | "detail" | "tiles";

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cx("rounded-md bg-muted motion-safe:animate-pulse", className)}
    />
  );
}

export function PageSkeleton({
  layout = "table",
}: {
  layout?: SkeletonLayout;
}) {
  const t = useTranslations("ui.pageState");
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      data-testid="page-state-loading"
      data-layout={layout}
      className="flex flex-col gap-4"
    >
      {layout !== "detail" ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonBlock key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-7 w-2/3 max-w-md" />
          <SkeletonBlock className="h-4 w-1/2 max-w-sm" />
        </div>
      )}
      {layout !== "tiles" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <SkeletonBlock className="mb-2 h-4 w-44" />
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <SkeletonBlock key={i} className="h-8" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

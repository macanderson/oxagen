import Link from "next/link";
import { cn } from "@/lib/utils";
import { USAGE_RANGES, type UsageRangeKey } from "./usage-format";

/**
 * Date-range preset picker. Pure links that set `?range=` — no client JS, so the
 * server component re-fetches the breakdown on navigation. Styled as a segmented
 * control.
 */
export function UsageRangePicker({
  basePath,
  active,
}: {
  basePath: string;
  active: UsageRangeKey;
}) {
  return (
    <div
      role="group"
      aria-label="Usage date range"
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
    >
      {USAGE_RANGES.map((r) => {
        const selected = r.key === active;
        return (
          <Link
            key={r.key}
            href={`${basePath}?range=${r.key}`}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {r.label}
          </Link>
        );
      })}
    </div>
  );
}

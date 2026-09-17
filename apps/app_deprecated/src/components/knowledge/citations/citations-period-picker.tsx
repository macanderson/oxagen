import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  DAY_PRESETS,
  type DayPreset,
} from "@/app/[orgSlug]/[workspaceSlug]/knowledge/citations/citations-format";

/**
 * Date-window preset picker for the Citations dashboard. Pure links that set
 * `?days=` — no client JS, so the server component re-fetches the dashboard
 * on navigation (mirrors UsageRangePicker in billing/usage).
 */
export function CitationsPeriodPicker({
  basePath,
  active,
}: {
  basePath: string;
  active: DayPreset;
}) {
  return (
    <div
      role="group"
      aria-label="Citations date range"
      className="inline-flex rounded-md border border-border bg-muted/40 p-0.5"
    >
      {DAY_PRESETS.map((days) => {
        const selected = days === active;
        return (
          <Link
            key={days}
            href={`${basePath}?days=${days}`}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {days}d
          </Link>
        );
      })}
    </div>
  );
}

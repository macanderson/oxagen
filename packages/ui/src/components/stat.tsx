import * as React from "react";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { cn } from "../lib/utils";
import { Skeleton } from "./skeleton";

/*
 * Stat — the shared KPI/metric tile.
 *
 * A dense, consistent shape for "big number + label + trend": usage meters,
 * billing totals, run counts. Value uses tabular numerals so live-updating
 * figures don't jitter. `StatGroup` frames a row of Stats with hairline
 * dividers (gap-px over the border token) — zero wasted chrome, works at any
 * wrap point.
 *
 *   <StatGroup>
 *     <Stat label="Spend (MTD)" value="$1,204.55" delta="+12.4%" trend="up" intent="negative" />
 *     <Stat label="Tool calls" value="48,391" delta="+3.1%" trend="up" />
 *   </StatGroup>
 */
export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Formatted change, e.g. "+12.4%". Rendered beside the trend arrow. */
  delta?: React.ReactNode;
  /** Arrow direction. Defaults the color intent: up=positive, down=negative. */
  trend?: "up" | "down" | "flat";
  /** Override the delta color when direction ≠ sentiment (e.g. cost going up). */
  intent?: "positive" | "negative" | "neutral";
  /** Small helper line under the value (e.g. "vs last 30 days"). */
  hint?: React.ReactNode;
  /** Leading icon, muted, top-right aligned. */
  icon?: React.ReactNode;
  /** Skeleton placeholders while the metric loads. */
  loading?: boolean;
  /** Status tint applied to the value itself (posture/health dashboards). */
  tone?: "neutral" | "success" | "warning" | "error";
}

const trendIcon = { up: TrendingUp, down: TrendingDown, flat: Minus } as const;
const intentClass = {
  positive: "text-success",
  negative: "text-error",
  neutral: "text-muted-foreground",
} as const;

const toneClass = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
} as const;

const Stat = React.forwardRef<HTMLDivElement, StatProps>(
  (
    {
      className,
      label,
      value,
      delta,
      trend,
      intent,
      hint,
      icon,
      loading,
      tone = "neutral",
      ...props
    },
    ref,
  ) => {
    const resolvedIntent =
      intent ??
      (trend === "up" ? "positive" : trend === "down" ? "negative" : "neutral");
    const TrendIcon = trend ? trendIcon[trend] : null;
    return (
      <div
        ref={ref}
        className={cn("relative flex min-w-0 flex-col gap-1 p-4", className)}
        {...props}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-xs font-medium text-muted-foreground">
            {label}
          </div>
          {icon && (
            <div
              aria-hidden="true"
              className="shrink-0 text-muted-foreground [&_svg]:size-4"
            >
              {icon}
            </div>
          )}
        </div>
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className={cn(
                "text-2xl font-semibold leading-none tracking-tight tabular-nums",
                toneClass[tone],
              )}
            >
              {value}
            </span>
            {(delta != null || TrendIcon) && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
                  intentClass[resolvedIntent],
                )}
              >
                {TrendIcon && (
                  <TrendIcon aria-hidden="true" className="size-3" />
                )}
                {delta}
              </span>
            )}
          </div>
        )}
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
    );
  },
);
Stat.displayName = "Stat";

/**
 * StatGroup — hairline-divided frame for a row of Stats. The `gap-px` over the
 * border color yields 1px dividers that stay correct at every responsive wrap
 * (no divide-x edge cases). Defaults to 2-up on small screens, one column per
 * stat from `lg` up (capped at 4).
 */
export interface StatGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Column count at the `lg` breakpoint. Defaults to the number of children (max 4). */
  columns?: 1 | 2 | 3 | 4;
}

const lgCols: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
};

const StatGroup = React.forwardRef<HTMLDivElement, StatGroupProps>(
  ({ className, columns, children, ...props }, ref) => {
    const count = React.Children.count(children);
    const cols = columns ?? (Math.min(Math.max(count, 1), 4) as 1 | 2 | 3 | 4);
    return (
      <div
        ref={ref}
        className={cn(
          "grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2",
          lgCols[cols],
          "[&>*]:bg-card",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
StatGroup.displayName = "StatGroup";

export { Stat, StatGroup };

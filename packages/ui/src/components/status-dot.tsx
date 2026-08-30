import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/*
 * StatusDot — the shared status indicator dot.
 *
 * Replaces the hand-rolled `rounded-full` + color-class spans scattered across
 * connection health, run states, and agent liveness. Semantic status tokens
 * only. Optional `pulse` renders a soft expanding ring for live/active states
 * (suppressed by the global reduced-motion kill-switch).
 *
 *   <StatusDot status="success" />
 *   <StatusDot status="info" pulse label="Running" />
 */
const statusDotVariants = cva("", {
  variants: {
    status: {
      success: "text-success",
      warning: "text-warning",
      error: "text-error",
      info: "text-info",
      neutral: "text-muted-foreground",
      primary: "text-primary",
    },
    size: {
      sm: "size-1.5",
      default: "size-2",
      lg: "size-2.5",
    },
  },
  defaultVariants: { status: "neutral", size: "default" },
});

export interface StatusDotProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusDotVariants> {
  /** Soft expanding ring for live states (running, streaming, online). */
  pulse?: boolean;
  /** Visible text rendered beside the dot. Also used as the accessible name. */
  label?: React.ReactNode;
  /** Screen-reader-only status name when no visible `label` is given. */
  srLabel?: string;
}

function StatusDot({
  className,
  status,
  size,
  pulse,
  label,
  srLabel,
  ...props
}: StatusDotProps) {
  const dotSize = statusDotVariants({ status, size });
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      {...props}
    >
      <span className={cn("relative inline-flex shrink-0", dotSize)}>
        {pulse && (
          <span
            aria-hidden="true"
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 [animation-duration:1.6s]",
              dotSize,
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex rounded-full bg-current",
            dotSize,
          )}
        />
      </span>
      {label != null ? (
        <span className="text-xs font-medium text-foreground">{label}</span>
      ) : srLabel ? (
        <span className="sr-only">{srLabel}</span>
      ) : null}
    </span>
  );
}

export { StatusDot, statusDotVariants };

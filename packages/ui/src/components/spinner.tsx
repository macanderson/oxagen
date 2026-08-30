import * as React from "react";
import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/*
 * Spinner — the single shared loading indicator. Inherits `currentColor` so it
 * reads correctly on any surface (buttons, table rows, empty panels). The
 * rotation is functional motion (allowed to stay linear) and is suppressed by
 * the global prefers-reduced-motion kill-switch.
 */
const spinnerVariants = cva("animate-spin", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      default: "size-4",
      lg: "size-5",
      xl: "size-6",
    },
  },
  defaultVariants: { size: "default" },
});

export interface SpinnerProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof spinnerVariants> {
  /**
   * Accessible loading announcement. Rendered visually hidden; the wrapper is
   * `role="status"` so screen readers announce the state change.
   */
  label?: string;
}

function Spinner({
  className,
  size,
  label = "Loading",
  ...props
}: SpinnerProps) {
  return (
    <span
      role="status"
      className={cn("inline-flex shrink-0", className)}
      {...props}
    >
      <Loader2 aria-hidden="true" className={spinnerVariants({ size })} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export { Spinner, spinnerVariants };

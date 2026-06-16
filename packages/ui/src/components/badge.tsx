"use client";
import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-error text-error-foreground hover:bg-error/80",
        // Surface badge — the token-driven neutral chip (badge-bg/fg/border).
        outline: "border-badge-border bg-badge-bg text-badge-fg",
        muted: "border-transparent bg-muted text-muted-foreground",
        // Brand surface badges — paper-tan brand and neutral accent.
        brand: "border-transparent bg-brand text-brand-foreground",
        cyan: "border-transparent bg-secondary text-secondary-foreground",
        // Semantic status variants (--info/--success/--warning/--error tokens).
        info: "border-transparent bg-info text-info-foreground",
        success: "border-transparent bg-success text-success-foreground",
        warning: "border-transparent bg-warning text-warning-foreground",
        error: "border-transparent bg-error text-error-foreground",
      },
      // coss ui adds size variants for density control. `lg` matches the fixed
      // shadcn/ui badge size.
      size: {
        sm: "px-2 py-0 text-[10px]",
        default: "px-2 py-0.5 text-xs",
        lg: "px-2.5 py-0.5 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Render the badge styling onto another element (Base UI `render`). */
  render?: React.ReactElement;
}

function Badge({ className, variant, size, render, children, ...props }: BadgeProps) {
  return useRender({
    render: render ?? <span />,
    props: {
      className: cn(badgeVariants({ variant, size }), className),
      ...props,
      // Forward children into the rendered element (default <span> or a
      // `render` element), so label content renders in both cases.
      children,
    },
  });
}

export { Badge, badgeVariants };

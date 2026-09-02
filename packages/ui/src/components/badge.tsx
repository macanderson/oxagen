"use client";
import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Default badge — an OUTLINED chip, never a filled/secondary surface.
        // `border-current` keys the outline to the ink (text) color so it
        // reads correctly on both light and dark layouts, and follows any
        // text-color override a caller applies. Never monospace.
        default: "border-current bg-transparent text-foreground",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        // Alias of default — the outlined ink chip IS the default now.
        outline: "border-current bg-transparent text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        // Brand surface badges — paper-tan brand and neutral accent.
        brand: "border-transparent bg-brand text-brand-foreground",
        cyan: "border-transparent bg-secondary text-secondary-foreground",
        // Semantic status variants (--info/--success/--warning/--error tokens).
        info: "border-transparent bg-info text-info-foreground",
        success: "border-transparent bg-success text-success-foreground",
        warning: "border-transparent bg-warning text-warning-foreground",
        error: "border-transparent bg-error text-error-foreground",
        // Soft status variants — tinted fill, status-colored ink. The shared
        // form of the `bg-success/12 text-success` pills hand-rolled across
        // inference/schema surfaces. Same semantic tokens, quieter volume.
        "info-soft": "border-info/25 bg-info/10 text-info",
        "success-soft": "border-success/25 bg-success/10 text-success",
        "warning-soft": "border-warning/25 bg-warning/10 text-warning",
        "error-soft": "border-error/25 bg-error/10 text-error",
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
  /** Leading status dot in the badge ink color (pairs with soft variants). */
  dot?: boolean;
}

function Badge({
  className,
  variant,
  size,
  render,
  dot,
  children,
  ...props
}: BadgeProps) {
  return useRender({
    render: render ?? <span />,
    props: {
      className: cn(badgeVariants({ variant, size }), className),
      ...props,
      // Forward children into the rendered element (default <span> or a
      // `render` element), so label content renders in both cases.
      children: dot ? (
        <>
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full bg-current opacity-80"
          />
          {children}
        </>
      ) : (
        children
      ),
    },
  });
}

export { Badge, badgeVariants };

"use client";
import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/*
 * Button — token-driven cva variants. The ONLY decorative motion kept anywhere
 * in the system is the button hover-grow: a small, transform-only scale on
 * hover that returns to rest on leave/press. No color flourish, no shadow, no
 * lift. All color/state comes from the --button-* tokens (see THEME.md).
 *
 * Variant map (public API preserved): `default`/`primary`/`gradient` are the
 * solid ink primary; `secondary`/`outline`/`ghost` are the neutral default;
 * `destructive*` use the error token; `link` is text-only.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-transform duration-[var(--motion-micro)] ease-[var(--ease-hover)] hover:scale-[var(--button-hover-scale)] active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:hover:scale-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-button-primary text-button-primary-foreground hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg",
        default:
          "bg-button-primary text-button-primary-foreground hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg",
        secondary:
          "border border-button-default-border bg-secondary text-secondary-foreground hover:bg-button-default-hover-bg active:bg-button-default-active-bg",
        outline:
          "border border-button-default-border bg-button-default text-button-default-foreground hover:bg-button-default-hover-bg active:bg-button-default-active-bg",
        ghost:
          "text-button-default-foreground hover:bg-button-default-hover-bg active:bg-button-default-active-bg",
        destructive:
          "bg-error text-error-foreground hover:bg-error/90 active:bg-error/80",
        // Outline destructive: error affordance without an alarming solid fill.
        "destructive-outline":
          "border border-error/50 bg-background text-error hover:bg-error/10",
        link: "text-foreground underline-offset-4 hover:underline hover:scale-100",
        // Legacy alias — flat solid ink (no gradient, no glow).
        gradient:
          "bg-button-primary text-button-primary-foreground hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg",
      },
      // coss ui scale — intentionally more compact than shadcn/ui. To preserve
      // a shadcn `default` height (36px) use `lg`; for a shadcn `lg` use `xl`.
      size: {
        xs: "h-6 rounded-md px-2 text-xs",
        sm: "h-7 rounded-md px-3 text-xs",
        default: "h-8 px-4 py-2",
        lg: "h-9 rounded-md px-6",
        xl: "h-10 rounded-md px-8",
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Render the button styling/behaviour onto another element (Base UI `render`).
   * Replaces the shadcn/Radix `asChild` pattern: pass a `ReactElement`.
   *
   *   <Button render={<Link href="/login" />}>Login</Button>
   */
  render?: React.ReactElement;
  /** Leading icon rendered before the label. Auto-sized to 1rem. */
  startIcon?: React.ReactNode;
  /** Trailing icon rendered after the label. */
  endIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, render, children, startIcon, endIcon, type, ...props },
    ref,
  ) =>
    useRender({
      render: render ?? <button type={type ?? "button"} />,
      ref,
      props: {
        className: cn(buttonVariants({ variant, size }), className),
        ...props,
        children:
          startIcon || endIcon ? (
            <>
              {startIcon}
              {children}
              {endIcon}
            </>
          ) : (
            children
          ),
      },
    }),
);
Button.displayName = "Button";

export { Button, buttonVariants };

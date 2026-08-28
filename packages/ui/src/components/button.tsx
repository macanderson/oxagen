"use client";
import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";
import { Spinner } from "./spinner";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./tooltip";

/*
 * Button — token-driven cva variants. The ONLY decorative motion kept anywhere
 * in the system is the button hover-grow: a small, transform-only scale on
 * hover that returns to rest on leave/press. No color flourish, no shadow, no
 * lift. Every color/border/ring/disabled state resolves through a --button-*
 * token (see THEME.md §5) — never a raw palette color, and never the core
 * --primary/--accent directly, so a reskin can retune buttons in isolation.
 *
 * Variant map (public API preserved): `default`/`primary`/`gradient` are the
 * solid brand primary; `secondary`/`outline`/`ghost` are the neutral default;
 * `destructive*` use the error token; `link` is text-only.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-transform duration-[var(--motion-micro)] ease-[var(--ease-hover)] hover:scale-[var(--button-hover-scale)] active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:hover:scale-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Solid brand primary — full --button-primary-* token set.
        primary:
          "border border-button-primary-border bg-button-primary-bg text-button-primary-fg hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg focus-visible:ring-button-primary-ring disabled:border-transparent disabled:bg-button-disabled-bg disabled:text-button-disabled-fg",
        default:
          "border border-button-primary-border bg-button-primary-bg text-button-primary-fg hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg focus-visible:ring-button-primary-ring disabled:border-transparent disabled:bg-button-disabled-bg disabled:text-button-disabled-fg",
        // Neutral filled — secondary surface, default-variant border/hover/ring.
        secondary:
          "border border-button-default-border bg-secondary text-secondary-foreground hover:bg-button-default-hover-bg active:bg-button-default-active-bg focus-visible:ring-button-default-ring disabled:bg-button-disabled-bg disabled:text-button-disabled-fg",
        // Neutral outline — transparent fill via --button-default-bg.
        outline:
          "border border-button-default-border bg-button-default-bg text-button-default-fg hover:bg-button-default-hover-bg active:bg-button-default-active-bg focus-visible:ring-button-default-ring disabled:text-button-disabled-fg",
        ghost:
          "text-button-default-fg hover:bg-button-default-hover-bg active:bg-button-default-active-bg focus-visible:ring-button-default-ring disabled:text-button-disabled-fg",
        destructive:
          "bg-error text-error-foreground hover:bg-error/90 active:bg-error/80 focus-visible:ring-error disabled:bg-button-disabled-bg disabled:text-button-disabled-fg",
        // Outline destructive: error affordance without an alarming solid fill.
        "destructive-outline":
          "border border-error/50 bg-background text-error hover:bg-error/10 focus-visible:ring-error disabled:text-button-disabled-fg",
        link: "text-foreground underline-offset-4 hover:underline hover:scale-100 focus-visible:ring-button-default-ring disabled:text-button-disabled-fg",
        // Alias of `primary` — resolves to the same flat solid style, no gradient.
        gradient:
          "border border-button-primary-border bg-button-primary-bg text-button-primary-fg hover:bg-button-primary-hover-bg active:bg-button-primary-active-bg focus-visible:ring-button-primary-ring disabled:border-transparent disabled:bg-button-disabled-bg disabled:text-button-disabled-fg",
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
  /**
   * When the button is `disabled`, show this content in a tooltip on hover/focus
   * (typically the reason it is disabled). The button is rendered inside a
   * focusable wrapper so the tooltip stays reachable even though a disabled
   * `<button>` emits no pointer events.
   */
  disabledTooltip?: React.ReactNode;
  /**
   * Pending state: swaps the leading icon for a spinner, disables the button
   * and sets `aria-busy`, while keeping the label visible so the button never
   * changes width. Use instead of hand-rolling `<Loader2 className="animate-spin" />`.
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      render,
      children,
      startIcon,
      endIcon,
      type,
      disabled,
      disabledTooltip,
      loading,
      ...props
    },
    ref,
  ) => {
    // While loading the spinner takes the leading-icon slot (replacing any
    // startIcon) so the label keeps its position and the button keeps its width.
    const lead = loading ? <Spinner size="sm" label="Loading" /> : startIcon;
    const isDisabled = disabled || loading;
    const element = useRender({
      render: render ?? <button type={type ?? "button"} />,
      ref,
      props: {
        className: cn(buttonVariants({ variant, size }), className),
        disabled: isDisabled,
        "aria-busy": loading || undefined,
        ...props,
        children:
          lead || endIcon ? (
            <>
              {lead}
              {children}
              {endIcon}
            </>
          ) : (
            children
          ),
      },
    });

    // A disabled button emits no pointer events (`disabled:pointer-events-none`),
    // so a tooltip attached directly to it would never open. Wrap it in a
    // focusable span that acts as the tooltip anchor: hover/focus lands on the
    // span and the tooltip explains why the action is unavailable.
    if (disabled && disabledTooltip != null) {
      return (
        <Tooltip>
          <TooltipTrigger
            render={<span tabIndex={0} className="inline-flex" />}
          >
            {element}
          </TooltipTrigger>
          <TooltipPopup>{disabledTooltip}</TooltipPopup>
        </Tooltip>
      );
    }

    return element;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

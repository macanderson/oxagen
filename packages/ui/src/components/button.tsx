"use client";
import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-[var(--motion-micro)] ease-[var(--ease-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:-translate-y-px active:translate-y-0",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:-translate-y-px active:translate-y-0",
        // Outline destructive: red affordance without an alarming solid fill.
        // Use for secondary destructive triggers; reserve `destructive` for the
        // primary destructive action.
        "destructive-outline":
          "border border-destructive/50 text-destructive bg-background shadow-sm hover:bg-destructive/10 hover:-translate-y-px active:translate-y-0",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground hover:-translate-y-px active:translate-y-0",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 hover:-translate-y-px active:translate-y-0",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        // Brand nebula gradient fill with white text and a violet glow on hover.
        gradient:
          "brand-gradient text-white shadow-sm hover:-translate-y-px hover:[box-shadow:var(--glow-violet)] active:translate-y-0",
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
  /**
   * Leading icon rendered before the label (oxagen-design-system Button spec).
   * Auto-sized to 1rem via the base `[&_svg]:size-4` rule; the `gap-2` between
   * icon and label is already part of the variant base.
   *
   *   <Button variant="gradient" startIcon={<ArrowUp />}>Run agent</Button>
   */
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
        // Forward children into the rendered element. For the default <button>
        // they are its content; for a `render` element (e.g. a Link/anchor)
        // Base UI merges them in, so icon/label children still render —
        // e.g. <Button render={<Link href />}>Login</Button>.
        //
        // startIcon/endIcon bracket the label. We only wrap in a fragment when
        // an icon is present so the common (no-icon) case forwards `children`
        // untouched — important for `render` targets that expect a single child.
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

import * as React from "react";
import { cn } from "../lib/utils";

/**
 * coss ui Card — neutral surface container.
 *
 * Optional treatments (all default off, backward compatible):
 * - `glow`         — retained for back-compat; flat UI renders no glow.
 * - `gradientRing` — retained for back-compat; uses the neutral border.
 * - `interactive`  — adds hover lift + pointer affordance (`hover-lift cursor-pointer`).
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Retained for back-compat; no ambient glow in the flat UI. */
  glow?: boolean;
  /** Retained for back-compat; keeps the neutral border in the flat UI. */
  gradientRing?: boolean;
  /** Add hover lift + pointer affordance for clickable cards. */
  interactive?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, glow: _glow, gradientRing: _gradientRing, interactive, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow",
        interactive && "hover-lift cursor-pointer",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

/**
 * CardHeader — a SUBTLY TINTED header (Graphite skin): just a hint of separation
 * from the card surface — a touch of gray on the white card in light mode, one
 * step up from the near-black card in dark mode — with the normal flipping ink
 * (dark text in light, soft white in dark). `rounded-t-xl` matches the Card
 * radius so it sits flush; the descendant `[&_p]` rule dims CardDescription to
 * 70% of the header ink so it stays legible.
 */
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex flex-col space-y-1.5 rounded-t-xl border-b border-border bg-card-header-bg px-6 py-4 text-card-header-fg [&_p]:text-card-header-fg/70",
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  ),
);
CardDescription.displayName = "CardDescription";

/** coss ui body wrapper. Replaces the shadcn `CardContent` name. */
const CardPanel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  ),
);
CardPanel.displayName = "CardPanel";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  ),
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardPanel, CardFooter };

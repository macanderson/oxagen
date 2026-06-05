"use client";
import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { cn } from "../lib/utils";

/**
 * coss ui RadioGroup — wraps Base UI `RadioGroup` (root) + `Radio.Root` + `Radio.Indicator`.
 *
 * Single-choice control for preferences. Selected state uses `--primary`.
 * State attributes on Radio: `data-[checked]` (selected), `data-[disabled]` (disabled).
 */
const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive
    ref={ref}
    className={cn("grid gap-2", className)}
    {...props}
  />
));
RadioGroup.displayName = "RadioGroup";

/**
 * Individual radio button within a `RadioGroup`.
 * Renders the outer ring + inner fill indicator.
 */
const Radio = React.forwardRef<
  React.ComponentRef<typeof RadioPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioPrimitive.Root
    ref={ref}
    className={cn(
      // Outer ring — border circle
      "aspect-square h-4 w-4 rounded-full border border-primary",
      "shadow-sm transition-colors duration-[var(--motion-base,160ms)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "flex items-center justify-center",
      className,
    )}
    {...props}
  >
    <RadioPrimitive.Indicator
      className={cn(
        // Inner fill dot — hidden when unchecked
        "hidden h-2 w-2 rounded-full bg-primary shadow-sm fill-primary",
        // Shown when checked
        "data-[checked]:block",
      )}
    />
  </RadioPrimitive.Root>
));
Radio.displayName = "Radio";

export { RadioGroup, Radio };

"use client";
import * as React from "react";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { cn } from "../lib/utils";

/**
 * coss ui RadioGroup — Base UI `RadioGroup` + `Radio.Root` + `Radio.Indicator`,
 * token-driven via the --control-* tokens. Flat (no shadow); the ring color
 * transitions on select.
 * State attributes on Radio: `data-[checked]` (selected), `data-[disabled]`.
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

/** Individual radio button — outer ring + inner fill indicator. */
const Radio = React.forwardRef<
  React.ComponentRef<typeof RadioPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioPrimitive.Root
    ref={ref}
    className={cn(
      "flex aspect-square h-4 w-4 items-center justify-center rounded-full border border-control-border",
      "transition-colors duration-[var(--motion-base)]",
      "data-[checked]:border-control-track-bg-checked",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-control-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <RadioPrimitive.Indicator
      className={cn(
        "hidden h-2 w-2 rounded-full bg-control-track-bg-checked",
        "data-[checked]:block",
      )}
    />
  </RadioPrimitive.Root>
));
Radio.displayName = "Radio";

export { RadioGroup, Radio };

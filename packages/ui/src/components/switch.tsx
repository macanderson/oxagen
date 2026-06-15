"use client";
import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../lib/utils";

/**
 * coss ui Switch — wraps Base UI `Switch.Root` + `Switch.Thumb`.
 *
 * Boolean toggle for preferences. On-state uses `--primary` as the track fill.
 * State attributes: `data-[checked]` (on), `data-[disabled]` (disabled).
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      // Track
      "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
      "shadow-sm transition-colors duration-[var(--motion-base,160ms)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // Unchecked track
      "bg-input",
      // Checked track — on-state uses `--primary` with a violet glow
      "data-[checked]:bg-primary data-[checked]:[box-shadow:var(--glow-violet)]",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        // Thumb
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg",
        "ring-0 transition-transform duration-[var(--motion-base,160ms)]",
        // Unchecked: translate to 0
        "translate-x-0",
        // Checked: translate to the right
        "data-[checked]:translate-x-4",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export { Switch };

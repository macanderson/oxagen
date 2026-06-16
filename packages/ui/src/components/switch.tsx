"use client";
import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "../lib/utils";

/**
 * coss ui Switch — Base UI `Switch.Root` + `Switch.Thumb`, fully token-driven
 * via the --control-* tokens. Flat (no shadow) but the track color and thumb
 * slide both animate.
 * State attributes: `data-[checked]` (on), `data-[disabled]` (disabled).
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
      "transition-colors duration-[var(--motion-base)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-control-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      // Track: unchecked vs checked
      "bg-control-track-bg data-[checked]:bg-control-track-bg-checked",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-control-thumb",
        "transition-transform duration-[var(--motion-base)]",
        "translate-x-0 data-[checked]:translate-x-4",
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

export { Switch };

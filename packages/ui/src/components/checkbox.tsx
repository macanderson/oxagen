"use client";
import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * coss ui Checkbox — Base UI `Checkbox.Root` + `Checkbox.Indicator`. Flat (no
 * shadow). UNCHECKED: a transparent box with a `--foreground`-coloured outline
 * (so it reads dark in light mode, light in dark mode — never a filled white
 * chip). CHECKED / INDETERMINATE: fills with the primary track colour and the
 * outline disappears into the fill; the mark colour is --control-indicator.
 * (The checked track + indicator colours stay on the shared --control-* tokens
 * that Radio and Switch also consume.)
 *
 * State attributes: `data-[checked]`, `data-[unchecked]`,
 * `data-[indeterminate]`, `data-[disabled]`.
 *
 *   <Checkbox checked={v} onCheckedChange={setV} />
 *   <label className="flex items-center gap-2 text-sm">
 *     <Checkbox defaultChecked /> Remember me
 *   </label>
 */
const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // Unchecked: transparent fill, foreground-coloured outline (flips with theme).
      "peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-foreground bg-transparent",
      "transition-colors duration-[var(--motion-base)]",
      // Checked / indeterminate: primary fill, outline folds into the fill.
      "data-[checked]:border-control-track-bg-checked data-[checked]:bg-control-track-bg-checked",
      "data-[indeterminate]:border-control-track-bg-checked data-[indeterminate]:bg-control-track-bg-checked",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-control-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn(
        "flex items-center justify-center text-control-indicator",
        // Check is shown by default; swap to the minus glyph when indeterminate.
        "[&>.coss-minus]:hidden data-[indeterminate]:[&>.coss-check]:hidden data-[indeterminate]:[&>.coss-minus]:block",
      )}
    >
      <Check className="coss-check size-3.5" aria-hidden="true" />
      <Minus className="coss-minus size-3.5" aria-hidden="true" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = "Checkbox";

export { Checkbox };

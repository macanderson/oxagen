"use client";
import * as React from "react";
import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "../lib/utils";

/**
 * coss ui Slider — wraps Base UI `Slider.Root`, `Slider.Control`, `Slider.Track`,
 * `Slider.Indicator`, `Slider.Thumb`, and `Slider.Value`.
 *
 * Numeric/stepped preference control (e.g. font-size scale, volume).
 * State attributes: `data-[dragging]`, `data-[disabled]`, `data-[orientation]`.
 */
const Slider = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("w-full", className)}
    {...props}
  >
    <SliderControl />
  </SliderPrimitive.Root>
));
Slider.displayName = "Slider";

const SliderControl = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Control>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Control>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Control
    ref={ref}
    className={cn(
      "relative flex w-full touch-none select-none items-center",
      "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
      className,
    )}
    {...props}
  >
    <SliderTrack>
      <SliderIndicator />
    </SliderTrack>
    <SliderThumb />
  </SliderPrimitive.Control>
));
SliderControl.displayName = "SliderControl";

const SliderTrack = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Track>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Track>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Track
    ref={ref}
    className={cn(
      "relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted",
      "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5",
      className,
    )}
    {...props}
  />
));
SliderTrack.displayName = "SliderTrack";

const SliderIndicator = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Indicator>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Indicator>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Indicator
    ref={ref}
    className={cn(
      "absolute h-full bg-primary",
      "data-[orientation=vertical]:bottom-0 data-[orientation=vertical]:h-auto data-[orientation=vertical]:w-full",
      className,
    )}
    {...props}
  />
));
SliderIndicator.displayName = "SliderIndicator";

const SliderThumb = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Thumb>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Thumb>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Thumb
    ref={ref}
    className={cn(
      "block h-4 w-4 rounded-full border border-primary/50 bg-background shadow",
      "ring-ring transition-colors",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:pointer-events-none disabled:opacity-50",
      "data-[dragging]:cursor-grabbing data-[dragging]:ring-2 data-[dragging]:ring-ring",
      className,
    )}
    {...props}
  />
));
SliderThumb.displayName = "SliderThumb";

const SliderValue = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Value>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Value>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Value
    ref={ref}
    className={cn("text-sm tabular-nums text-muted-foreground", className)}
    {...props}
  />
));
SliderValue.displayName = "SliderValue";

export {
  Slider,
  SliderControl,
  SliderTrack,
  SliderIndicator,
  SliderThumb,
  SliderValue,
};

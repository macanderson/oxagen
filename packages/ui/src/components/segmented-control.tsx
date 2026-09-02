"use client";
import * as React from "react";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Toggle } from "@base-ui/react/toggle";
import { cn } from "../lib/utils";

/**
 * coss ui SegmentedControl — wraps Base UI `ToggleGroup` + `Toggle`.
 *
 * Single-select pill control for discrete preference choices such as:
 * - Font size: Small / Medium / Large
 * - Density: Compact / Comfortable / Spacious
 * - Prompt behavior: Queue / Interrupt
 *
 * Controlled via `value` / `onValueChange` (single string, not array).
 * Base UI `ToggleGroup` is array-based; this wrapper enforces single-select
 * by accepting a single string value and converting to/from the Base UI
 * array-based API. `multiple` is always false.
 *
 * State attributes on items: `data-[pressed]` (selected), `data-[disabled]`.
 */
interface SegmentedControlProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof ToggleGroup>,
    "value" | "defaultValue" | "onValueChange" | "multiple"
  > {
  /** The currently selected item value (controlled). */
  value?: string;
  /** The initially selected item value (uncontrolled). */
  defaultValue?: string;
  /** Called when the selected item changes. */
  onValueChange?: (value: string) => void;
}

const SegmentedControl = React.forwardRef<
  HTMLDivElement,
  SegmentedControlProps
>(({ className, value, defaultValue, onValueChange, ...props }, ref) => {
  const groupValue = value !== undefined ? [value] : undefined;
  const groupDefault = defaultValue !== undefined ? [defaultValue] : undefined;

  const handleValueChange = React.useCallback(
    (groupValues: string[]) => {
      // Single-select: take the last pressed value; ignore empty (deselect not allowed)
      const next = groupValues[groupValues.length - 1];
      if (next !== undefined) {
        onValueChange?.(next);
      }
    },
    [onValueChange],
  );

  return (
    <ToggleGroup
      ref={ref}
      multiple={false}
      value={groupValue}
      defaultValue={groupDefault}
      onValueChange={handleValueChange}
      className={cn(
        "inline-flex h-8 items-center rounded-md bg-muted p-0.5 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
});
SegmentedControl.displayName = "SegmentedControl";

/**
 * Individual item within a `SegmentedControl`.
 * State attributes: `data-[pressed]` (selected), `data-[disabled]`.
 */
interface SegmentedControlItemProps
  extends React.ComponentPropsWithoutRef<typeof Toggle> {
  value: string;
}

const SegmentedControlItem = React.forwardRef<
  HTMLButtonElement,
  SegmentedControlItemProps
>(({ className, ...props }, ref) => (
  <Toggle
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1 text-sm font-medium",
      // Fallback matches --motion-base's own value, for the (unexpected) case
      // where @oxagen/ui's globals.css is not loaded.
      "ring-offset-background transition-all duration-[var(--motion-base,220ms)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      "disabled:pointer-events-none disabled:opacity-50",
      // Selected state
      "data-[pressed]:bg-background data-[pressed]:text-foreground data-[pressed]:shadow-sm",
      className,
    )}
    {...props}
  />
));
SegmentedControlItem.displayName = "SegmentedControlItem";

export { SegmentedControl, SegmentedControlItem };
export type { SegmentedControlProps, SegmentedControlItemProps };

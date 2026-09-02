"use client";
import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

/*
 * Select — token-driven. The trigger mirrors the input tokens; the popup uses
 * the --menu-* tokens; items wire highlighted/selected/disabled through Base
 * UI data-attributes. Flat (no shadow), but the popup keeps the shared
 * enter/exit transition every other overlay uses.
 */
const selectTriggerVariants = cva(
  "flex w-full items-center justify-between whitespace-nowrap rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-input-fg placeholder:text-input-placeholder hover:border-input-border-hover focus:outline-none focus:border-input-border-focus focus:ring-1 focus:ring-input-ring data-[popup-open]:border-input-border-focus disabled:cursor-not-allowed disabled:bg-input-disabled-bg disabled:text-input-disabled-fg [&>span]:line-clamp-1",
  {
    // coss ui density scale. `lg` matches the shadcn/ui trigger height (36px).
    variants: {
      size: {
        sm: "h-7",
        default: "h-8",
        lg: "h-9",
      },
    },
    defaultVariants: { size: "default" },
  },
);

interface SelectTriggerProps
  extends Omit<
      React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>,
      "size"
    >,
    VariantProps<typeof selectTriggerVariants> {}

const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  SelectTriggerProps
>(({ className, size, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(selectTriggerVariants({ size }), className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = "SelectTrigger";

interface SelectPopupProps
  extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Popup> {
  sideOffset?: number;
  /**
   * When `true`, the popup aligns the selected item with the trigger text
   * (Base UI default). Defaults to `false` for a conventional dropdown.
   */
  alignItemWithTrigger?: boolean;
  /** Forwarded to Base UI `Select.Portal` (e.g. `keepMounted`, custom `container`). */
  portalProps?: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Portal>;
}

const SelectPopup = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Popup>,
  SelectPopupProps
>(
  (
    {
      className,
      children,
      sideOffset = 4,
      alignItemWithTrigger = false,
      portalProps,
      ...props
    },
    ref,
  ) => (
    <SelectPrimitive.Portal {...portalProps}>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="z-50"
      >
        <SelectPrimitive.Popup
          ref={ref}
          className={cn(
            "relative z-50 max-h-[min(var(--available-height),320px)] min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border border-menu-popup-border bg-menu-popup-bg text-menu-popup-fg",
            "origin-[var(--transform-origin)] transition-[opacity,transform,translate,scale] duration-[var(--motion-overlay)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:-translate-y-1 data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:-translate-y-1",
            className,
          )}
          {...props}
        >
          <div className="p-1">{children}</div>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  ),
);
SelectPopup.displayName = "SelectPopup";

const SelectLabel = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.GroupLabel>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.GroupLabel>
>(({ className, ...props }, ref) => (
  <SelectPrimitive.GroupLabel
    ref={ref}
    className={cn(
      "px-2 py-1.5 text-sm font-semibold text-menu-group-label-fg",
      className,
    )}
    {...props}
  />
));
SelectLabel.displayName = "SelectLabel";

const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-menu-item-fg outline-none data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg data-[selected]:bg-menu-item-selected-bg data-[selected]:text-menu-item-selected-fg data-[disabled]:pointer-events-none data-[disabled]:text-menu-item-disabled-fg",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = "SelectItem";

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectPopup,
  SelectLabel,
  SelectItem,
};

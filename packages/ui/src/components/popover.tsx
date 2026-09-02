"use client";
import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "../lib/utils";

/**
 * coss ui Popover — Base UI Popover, token-driven.
 *
 *   <Popover>
 *     <PopoverTrigger render={<Button variant="ghost" size="icon" />}>
 *       <HelpCircle />
 *     </PopoverTrigger>
 *     <PopoverPopup>
 *       <PopoverTitle>What is a registry?</PopoverTitle>
 *       <PopoverDescription>…</PopoverDescription>
 *     </PopoverPopup>
 *   </Popover>
 *
 * Uses Base UI's `render` prop (not `asChild`). The popup is portalled and
 * positioned. `side`/`align`/`sideOffset` tune placement.
 */
const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverClose = PopoverPrimitive.Close;
const PopoverTitle = PopoverPrimitive.Title;
const PopoverDescription = PopoverPrimitive.Description;

interface PopoverPopupProps
  extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Popup> {
  sideOffset?: number;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  /** Forwarded to Base UI `Popover.Portal`. */
  portalProps?: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Portal>;
}

const PopoverPopup = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Popup>,
  PopoverPopupProps
>(
  (
    {
      className,
      sideOffset = 8,
      align = "start",
      side = "bottom",
      portalProps,
      ...props
    },
    ref,
  ) => (
    <PopoverPrimitive.Portal {...portalProps}>
      <PopoverPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          ref={ref}
          className={cn(
            "z-50 max-w-sm rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-md",
            "origin-[var(--transform-origin)] transition-[opacity,transform,translate,scale] duration-[var(--motion-overlay)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.97]",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  ),
);
PopoverPopup.displayName = "PopoverPopup";

export {
  Popover,
  PopoverTrigger,
  PopoverClose,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
};

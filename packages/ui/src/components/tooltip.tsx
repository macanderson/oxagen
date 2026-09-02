"use client";
import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "../lib/utils";

/**
 * coss ui Tooltip — Base UI Tooltip, token-driven via the --tooltip-* tokens.
 * Mount <TooltipProvider> once near the app root so hover open/close delays are
 * shared across the app (Base UI's grouping behaviour); an individual <Tooltip>
 * still works standalone without it.
 *
 *   <Tooltip>
 *     <TooltipTrigger render={<Button variant="ghost" size="icon" />}>
 *       <Bell />
 *     </TooltipTrigger>
 *     <TooltipPopup>Notifications</TooltipPopup>
 *   </Tooltip>
 *
 * Composition uses Base UI's `render` prop (not `asChild`). The popup is
 * portalled and positioned; `side`/`align`/`sideOffset` tune placement. Follows
 * the same Portal → Positioner → Popup shape and motion tokens as Menu/Select.
 */
const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

interface TooltipPopupProps
  extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Popup> {
  sideOffset?: number;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  /** Forwarded to Base UI `Tooltip.Portal` (e.g. `keepMounted`, custom `container`). */
  portalProps?: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Portal>;
}

const TooltipPopup = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Popup>,
  TooltipPopupProps
>(
  (
    {
      className,
      sideOffset = 6,
      align = "center",
      side = "top",
      portalProps,
      ...props
    },
    ref,
  ) => (
    <TooltipPrimitive.Portal {...portalProps}>
      <TooltipPrimitive.Positioner
        sideOffset={sideOffset}
        align={align}
        side={side}
        className="z-50"
      >
        <TooltipPrimitive.Popup
          ref={ref}
          className={cn(
            "z-50 max-w-xs rounded-md border border-tooltip-border bg-tooltip-bg px-2 py-1 text-xs font-medium text-tooltip-fg",
            "origin-[var(--transform-origin)] transition-[opacity,transform,translate,scale] duration-[var(--motion-overlay)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.96]",
            className,
          )}
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  ),
);
TooltipPopup.displayName = "TooltipPopup";

export { Tooltip, TooltipTrigger, TooltipPopup, TooltipProvider };

"use client";
/**
 * WandButton — the floating magic-wand trigger button.
 *
 * Fixed bottom-right of the viewport with equal margins (1.5rem).
 * Circular, Wand2 icon, solid ink ring (on-brand).
 * Accessible: aria-label, focus ring, keyboard-openable.
 * Hidden on narrow mobile when the bottom tab bar is visible (offset above it).
 *
 * Accessibility notes (frontend-patterns §a11y):
 *   - role="button" is implicit from <button>.
 *   - aria-label describes the action (toggles the agent panel).
 *   - aria-expanded reflects panel open state.
 *   - focus-visible ring uses ring-ring token.
 *   - prefers-reduced-motion: the ring pulse animation is suppressed.
 */

import * as React from "react";
import { usePathname } from "next/navigation";
import { Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import { usePageContext } from "@/lib/page-context";

export interface WandButtonProps {
  /** Additional class names for the outer positioned container. */
  className?: string;
}

export function WandButton({ className }: WandButtonProps) {
  const { isWandOpen, openWand, closeWand } = usePageContext();
  const pathname = usePathname();
  const isAskPage = pathname.endsWith("/ask");

  if (isAskPage) return null;

  const handleClick = () => {
    if (isWandOpen) {
      closeWand();
    } else {
      openWand();
    }
  };

  return (
    <div
      className={cn(
        // Position: fixed bottom-right, equal 1.5rem margins.
        // z-40 puts it above normal content but below modals (z-50).
        "fixed bottom-6 right-6 z-40",
        // On mobile: float above the MobileBottomBar (--bottom-bar-h) with a
        // comfortable 1.5rem gap, clearing the device safe area too. The bar is
        // visible below the md breakpoint; above it the FAB returns to bottom-6.
        "bottom-[calc(var(--bottom-bar-h)+1.5rem+env(safe-area-inset-bottom))] md:bottom-6",
        className,
      )}
      // Keep the button out of the main document landmark so it doesn't
      // interrupt tab order in large page forms.
      aria-label="Oxagen AI agent"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={handleClick}
              aria-label={isWandOpen ? "Close AI agent" : "Open AI agent"}
              aria-expanded={isWandOpen}
              aria-controls="wand-panel"
              className={cn(
                // Size and shape.
                "relative flex h-12 w-12 items-center justify-center rounded-full",
                // Background: muted dark surface.
                "bg-background shadow-lg",
                // The ring — a pseudo-element ring using a solid ink fill, carved to a
                // border via the inner circle below.
                "ring-2 ring-offset-1",
                // Default ring is ink; open state uses a tighter ring.
                isWandOpen
                  ? "ring-primary/60"
                  : "ring-transparent",
                // Focus ring (keyboard).
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                // Hover / press affordance.
                "transition-transform duration-150 hover:scale-105 active:scale-95",
                // Ring animation when closed — suppressed at prefers-reduced-motion.
                !isWandOpen && "wand-ring-gradient",
              )}
            />
          }
        >
          {/* Ring layer — solid ink, decorative, aria-hidden. The inner circle
              below masks the fill so only the ring border shows. */}
          <span
            className={cn(
              "absolute inset-0 rounded-full",
              // Solid ink fill matching the brand identity.
              "bg-primary",
              "opacity-80",
              // Pulsing ring when closed to draw attention; disabled with reduced motion.
              !isWandOpen && "animate-[wand-ring-pulse_3s_ease-in-out_infinite] motion-reduce:animate-none",
            )}
            aria-hidden="true"
          />

          {/* Inner circle — sits above the gradient ring. */}
          <span
            className="absolute inset-[3px] rounded-full bg-background"
            aria-hidden="true"
          />

          {/* Icon — on top of the inner circle. */}
          <Wand2
            className={cn(
              "relative h-5 w-5 transition-colors duration-150",
              isWandOpen
                ? "text-primary"
                : "text-foreground",
            )}
            aria-hidden="true"
          />
        </TooltipTrigger>
        <TooltipPopup side="left">{isWandOpen ? "Close AI agent" : "Open AI agent"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * FieldFillTransition — wraps a form field with an accent-glow highlight
 * animation when `active` transitions from false → true (Ask-to-Fill signal).
 *
 * Integration contract:
 *   import { FieldFillTransition } from "@/components/ui/field-fill-transition"
 *   <FieldFillTransition active={fieldIsBeingFilled}>
 *     <input ... />
 *   </FieldFillTransition>
 *
 * When `active` is true:
 *   - A brief accent glow ring pulses over the field (CSS @keyframes).
 *   - The field wrapper background cross-fades to a subtle accent tint.
 *   - Motion is fully disabled under prefers-reduced-motion — state still
 *     changes but no animation plays.
 *
 * This is a purely CSS-driven transition (no Framer Motion dependency).
 * The `active` state change is owned by the Ask system (Stage 2 — B2).
 */

"use client";

import * as React from "react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface FieldFillTransitionProps {
  /** When true, plays the accent-glow highlight. */
  active: boolean;
  children: ReactNode;
  className?: string;
}

export function FieldFillTransition({
  active,
  children,
  className,
}: FieldFillTransitionProps) {
  return (
    <div
      data-fill-active={active ? "true" : undefined}
      className={cn(
        // Base: relative so the glow pseudo-element can be positioned
        "relative rounded-xl transition-[background-color,box-shadow]",
        /*
         * Transition durations aligned with design-system tokens:
         *   background: 220ms base
         *   box-shadow:  220ms base
         * Both use the design-system easing: cubic-bezier(0.22, 1, 0.36, 1)
         */
        "duration-[220ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
        // Inactive state
        !active && "bg-transparent shadow-none",
        // Active state: subtle accent tint + outer glow ring
        active && [
          "bg-accent/5",
          "shadow-[0_0_0_2px_hsl(var(--accent)/0.4),0_0_16px_4px_hsl(var(--accent)/0.15)]",
          // Glow pulse animation — disabled under prefers-reduced-motion
          "motion-safe:animate-[field-fill-glow_600ms_cubic-bezier(0.22,1,0.36,1)_forwards]",
        ],
        className,
      )}
    >
      {children}

      {/*
       * Keyframe is injected inline via a <style> tag so this component is
       * self-contained and doesn't require a global CSS change.
       * The animation plays once, peaks at 50%, then settles to the resting
       * box-shadow defined on the wrapper above.
       *
       * prefers-reduced-motion: the `motion-safe:` Tailwind variant on the
       * wrapper means the animate class is never applied in reduced-motion
       * contexts, so there is zero motion for those users.
       */}
      {active && (
        <style>{`
          @keyframes field-fill-glow {
            0%   { box-shadow: 0 0 0 2px hsl(var(--accent) / 0), 0 0 0px 0px hsl(var(--accent) / 0); }
            40%  { box-shadow: 0 0 0 3px hsl(var(--accent) / 0.55), 0 0 24px 8px hsl(var(--accent) / 0.25); }
            100% { box-shadow: 0 0 0 2px hsl(var(--accent) / 0.4), 0 0 16px 4px hsl(var(--accent) / 0.15); }
          }
        `}</style>
      )}
    </div>
  );
}

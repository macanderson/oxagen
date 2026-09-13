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
 * This is a purely CSS-driven transition (no Framer Motion dependency). The
 * `active` state change is owned by the Ask system's fill overlay.
 */

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface FieldFillTransitionProps {
  /** When true, plays the accent-glow highlight. */
  active: boolean;
  children: React.ReactNode;
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
      // Resting ring lives in an inline style (raw CSS) so the brand color-mix()
      // expression isn't run through Tailwind's arbitrary-value parser. Flat
      // re-skin: a solid brand RING (no blur/glow) — the keyframe below animates
      // the ring; for reduced-motion users this is the steady ring.
      style={
        active
          ? {
              boxShadow:
                "0 0 0 2px color-mix(in oklch, var(--brand) 45%, transparent)",
            }
          : undefined
      }
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
        // Active state: subtle brand tint + outer glow ring
        active && [
          "bg-brand/5",
          // Glow pulse animation — disabled under prefers-reduced-motion
          "motion-safe:animate-[field-fill-glow_600ms_cubic-bezier(0.22,1,0.36,1)_forwards]",
        ],
        className,
      )}
    >
      {children}

      {/*
       * Keyframe is injected inline via a <style> tag so the component ships
       * with its own animation. Note the `@keyframes` name is GLOBAL: several
       * simultaneously-active fields each emit an identical copy of this rule.
       * The animation plays once, peaks at 40%, then settles to the resting
       * box-shadow defined on the wrapper above.
       *
       * prefers-reduced-motion: the `motion-safe:` Tailwind variant on the
       * wrapper means the animate class is never applied in reduced-motion
       * contexts, so there is zero motion for those users.
       */}
      {active && (
        <style>{`
          @keyframes field-fill-glow {
            0%   { box-shadow: 0 0 0 0px color-mix(in oklch, var(--brand) 0%, transparent); }
            40%  { box-shadow: 0 0 0 4px color-mix(in oklch, var(--brand) 70%, transparent); }
            100% { box-shadow: 0 0 0 2px color-mix(in oklch, var(--brand) 45%, transparent); }
          }
        `}</style>
      )}
    </div>
  );
}

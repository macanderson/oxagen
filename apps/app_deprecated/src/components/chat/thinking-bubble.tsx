"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

interface ThinkingBubbleProps {
  className?: string;
}

// Three staggered dots tinted with the info token, animating with a gentle bounce.
// Entry/exit animation lives in the wrapping TimelineItem (fadeInUp variant).
// The bounce here is purely decorative — dots pulse in sequence with the brand
// easing [0.45,0,0.55,1] matching the ReasoningCard pulse timing.
export function ThinkingBubble({ className }: ThinkingBubbleProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div
      className={cn("flex items-center gap-1.5 py-1", className)}
      data-component="thinking-bubble"
      role="status"
      aria-label="Thinking"
    >
      {([0, 1, 2] as const).map((i) => (
        <motion.span
          key={i}
          className="block h-2 w-2 rounded-full bg-info"
          animate={
            reducedMotion
              ? { opacity: 0.7 }
              : { y: [0, -5, 0], opacity: [0.5, 1, 0.5] }
          }
          transition={
            reducedMotion
              ? undefined
              : {
                  duration: 0.9,
                  ease: [0.45, 0, 0.55, 1],
                  repeat: Infinity,
                  delay: i * 0.16,
                }
          }
        />
      ))}
    </div>
  );
}

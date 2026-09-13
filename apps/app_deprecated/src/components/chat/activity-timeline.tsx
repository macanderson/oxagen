"use client";

/**
 * ActivityTimeline + TimelineItem — vertical thread chrome for agent steps.
 *
 * Renders a left rail (dot + connector line) alongside arbitrary children.
 * The parent maps an ordered list of steps to <TimelineItem> nodes; this
 * component only owns layout and motion — no data fetching.
 *
 * Design intent: restrained, monochrome with tonal dot color. The continuous
 * connector line visually links steps dot-to-dot. Stagger reveal on mount.
 */

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { fadeInUp, staggerContainer } from "@oxagen/ui/lib/motion";

// ---------------------------------------------------------------------------
// Tone → color mapping
// ---------------------------------------------------------------------------

const dotColorMap: Record<NonNullable<TimelineItemProps["tone"]>, string> = {
  thinking: "bg-info",
  running: "bg-info",
  done: "bg-success",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

// ---------------------------------------------------------------------------
// TimelineItem
// ---------------------------------------------------------------------------

export interface TimelineItemProps {
  children: React.ReactNode;
  /** true while this node's underlying activity is in-flight → pulsing ring. */
  isActive?: boolean;
  /** true for the last item → hide the downward connector line. */
  isLast?: boolean;
  /** optional status tint for the node dot */
  tone?: "thinking" | "running" | "done" | "failed" | "idle";
  /**
   * Optional DOM id stamped on the outer node, so other UI (e.g. the
   * coding-trace-panel rail) can deep-link to this exact card via
   * `<a href="#id">` / native fragment scroll.
   */
  id?: string;
}

export function TimelineItem({
  children,
  isActive = false,
  isLast = false,
  tone = "idle",
  id,
}: TimelineItemProps) {
  const reducedMotion = useReducedMotion();

  const dotColor = dotColorMap[tone];
  const ringColor = dotColor;

  return (
    <motion.div
      id={id}
      className="flex gap-0 items-stretch scroll-mt-4"
      variants={fadeInUp}
      data-component="timeline-item"
      data-tone={tone}
    >
      {/* Left rail: dot + connector line */}
      <div className="relative flex w-6 shrink-0 flex-col items-center">
        {/* Node dot with optional pulsing ring */}
        <div className="relative mt-[0.6875rem] flex items-center justify-center">
          {/* Ping ring — only when active and not reduced motion */}
          {isActive && !reducedMotion && (
            <span
              className={cn(
                "absolute inline-flex h-4 w-4 rounded-full opacity-30 animate-ping",
                ringColor,
              )}
              aria-hidden="true"
            />
          )}
          {/* Dot */}
          <span
            className={cn("relative h-2.5 w-2.5 rounded-full", dotColor)}
            aria-hidden="true"
          />
        </div>

        {/* Connector line — fills remaining height toward the next dot */}
        {!isLast && (
          <div className="mt-1 flex-1 w-px bg-border" aria-hidden="true" />
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 pb-3 pt-2">{children}</div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// ActivityTimeline
// ---------------------------------------------------------------------------

export interface ActivityTimelineProps {
  children: React.ReactNode;
  className?: string;
}

export function ActivityTimeline({
  children,
  className,
}: ActivityTimelineProps) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className={cn("relative flex flex-col gap-0", className)}
      variants={reducedMotion ? undefined : staggerContainer}
      initial={reducedMotion ? undefined : "hidden"}
      animate={reducedMotion ? undefined : "visible"}
    >
      {children}
    </motion.div>
  );
}

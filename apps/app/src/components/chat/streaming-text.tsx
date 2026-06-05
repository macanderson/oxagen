"use client";

/**
 * StreamingText — typewriter reveal for streamed assistant text.
 *
 * The chat SSE stream concatenates text deltas onto a single accumulating
 * string (see `use-tool-stream.ts`). Rendering that string directly snaps in
 * whole chunks whenever the model flushes. This component instead reveals the
 * accumulated text one slice per animation frame, so the response reads as if
 * it is being *written* — with a blinking caret trailing the cursor — even when
 * the underlying deltas arrive in bursts.
 *
 * Design intent (oxagen-design-system motion): restrained, not gimmicky. The
 * reveal speed scales with how far behind the cursor is, so a fast model never
 * leaves the reader waiting, while a steady trickle still types deliberately.
 *
 * Accessibility: under `prefers-reduced-motion` (surfaced via framer-motion's
 * `useReducedMotion`, wired to `reducedMotion="user"` by the app MotionProvider)
 * the full text renders immediately with no caret — no per-frame churn.
 */

import * as React from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export interface StreamingTextProps {
  /** The full accumulated text so far (grows as deltas arrive). */
  text: string;
  /** While true, a caret blinks at the cursor even once caught up. */
  isStreaming?: boolean;
  className?: string;
}

// Floor reveal rate in characters/second; the actual rate climbs with backlog
// (see the loop) so the cursor catches a fast stream within a beat.
const BASE_CPS = 90;

export function StreamingText({ text, isStreaming = false, className }: StreamingTextProps) {
  const reduceMotion = useReducedMotion();
  const [displayed, setDisplayed] = React.useState("");

  // Latest target text + how many chars we've revealed, held in refs so the
  // rAF loop reads current values without being torn down on every delta.
  const targetRef = React.useRef(text);
  const countRef = React.useRef(0);
  const rafRef = React.useRef<number | null>(null);
  const lastTsRef = React.useRef(0);
  targetRef.current = text;

  // The single rAF stepper. Self-reschedules until the cursor catches the
  // target, then parks itself (rafRef = null) to be restarted by the effect
  // below when more text arrives.
  const step = React.useCallback((ts: number) => {
    const target = targetRef.current;
    if (countRef.current >= target.length) {
      rafRef.current = null;
      return;
    }
    const last = lastTsRef.current || ts;
    // Clamp large frame gaps (tab backgrounded) so we don't leap the whole
    // string at once on the first frame back.
    const dt = Math.min(0.05, (ts - last) / 1000);
    lastTsRef.current = ts;

    const remaining = target.length - countRef.current;
    const cps = Math.max(BASE_CPS, remaining * 6);
    const advance = Math.max(1, Math.round(cps * dt));
    countRef.current = Math.min(target.length, countRef.current + advance);
    setDisplayed(target.slice(0, countRef.current));

    rafRef.current = requestAnimationFrame(step);
  }, []);

  // Reduced motion: always show the complete text, never animate.
  React.useEffect(() => {
    if (!reduceMotion) return;
    countRef.current = text.length;
    setDisplayed(text);
  }, [reduceMotion, text]);

  // Drive / restart the reveal as the target grows (or resets on a new turn).
  React.useEffect(() => {
    if (reduceMotion) return;
    // New turn: the accumulator shrank (reset to ""), so rewind the cursor.
    if (countRef.current > text.length) {
      countRef.current = 0;
      setDisplayed("");
    }
    if (rafRef.current === null && countRef.current < text.length) {
      lastTsRef.current = 0;
      rafRef.current = requestAnimationFrame(step);
    }
  }, [text, reduceMotion, step]);

  // Cancel any in-flight frame on unmount.
  React.useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const caretVisible = !reduceMotion && (isStreaming || displayed.length < text.length);

  return (
    <div className={cn("whitespace-pre-wrap leading-relaxed", className)}>
      {reduceMotion ? text : displayed}
      {caretVisible ? <span className="stream-caret ml-0.5" aria-hidden="true" /> : null}
    </div>
  );
}

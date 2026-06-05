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
 * Lifecycle: callers key one instance per assistant message
 * (`key={msg.messageId}`), so a new turn mounts a fresh component — the cursor
 * starts at 0 with no reset bookkeeping. Within a message the accumulated text
 * only ever grows.
 *
 * Accessibility: under `prefers-reduced-motion` (surfaced via framer-motion's
 * `useReducedMotion`, wired to `reducedMotion="user"` by the app MotionProvider)
 * the full text renders immediately with no caret and no animation frames.
 */

import * as React from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { MarkdownMessage } from "./markdown-message";

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
  const [count, setCount] = React.useState(0);

  // Revealed-character count persisted across deltas. The effect re-runs on
  // every `text` change with a fresh closure over the latest text, so the loop
  // always animates toward the current snapshot without a render-phase ref.
  const countRef = React.useRef(0);

  React.useEffect(() => {
    if (reduceMotion) return;
    let frame = 0;
    let lastTs = 0;
    // rAF stepper, defined inside the effect so it closes over the current
    // `text`. Reschedules until the cursor catches the snapshot, then parks.
    // setState lives in this frame callback (not the effect body), so it does
    // not trigger cascading synchronous renders.
    const loop = (ts: number) => {
      if (countRef.current >= text.length) return;
      const last = lastTs || ts;
      // Clamp large frame gaps (e.g. backgrounded tab) so we don't leap the
      // whole string at once on the first frame back.
      const dt = Math.min(0.05, (ts - last) / 1000);
      lastTs = ts;
      const remaining = text.length - countRef.current;
      const cps = Math.max(BASE_CPS, remaining * 6);
      const advance = Math.max(1, Math.round(cps * dt));
      countRef.current = Math.min(text.length, countRef.current + advance);
      setCount(countRef.current);
      frame = requestAnimationFrame(loop);
    };
    if (countRef.current < text.length) {
      frame = requestAnimationFrame(loop);
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [text, reduceMotion]);

  // Reduced motion shows everything at once; otherwise reveal up to the cursor.
  // slice() clamps, so a stale `count` never over- or under-reads `text`.
  const displayed = reduceMotion ? text : text.slice(0, count);
  const caretVisible = !reduceMotion && (isStreaming || count < text.length);

  return (
    <div className={cn("relative", className)}>
      <MarkdownMessage streaming={isStreaming || count < text.length}>
        {displayed}
      </MarkdownMessage>
      {caretVisible ? <span className="stream-caret ml-0.5" aria-hidden="true" /> : null}
    </div>
  );
}

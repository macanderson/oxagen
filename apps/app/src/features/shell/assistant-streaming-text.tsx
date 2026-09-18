"use client";
// Reveals an assistant reply a few characters at a time instead of snapping
// the whole string in at once. `ask_assistant` is one `kernelWrite`, not a
// stream — rev1 ships no second transport (ARCHITECTURE.md §1.2, ADR-053) —
// so the full reply is already in hand when this mounts; this only changes
// how it is painted, the way `app_deprecated`'s `StreamingText` did for the
// chat surface it replaces.
//
// Callers key one instance per turn (`assistant-flyout.tsx` keys the `<li>`
// on the entry id, which this mounts under), so a new reply always starts
// its own reveal at 0 rather than resuming another turn's cursor.
import { useEffect, useRef, useState } from "react";
import { AssistantMarkdown } from "./assistant-markdown";

/** Floor reveal rate in characters/second; the loop below climbs above this
 * as the backlog grows, so a long reply still finishes in a beat. */
const BASE_CHARS_PER_SECOND = 90;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface AssistantStreamingTextProps {
  text: string;
}

export function AssistantStreamingText({ text }: AssistantStreamingTextProps) {
  // Read once: this only ever mounts client-side, after a reply has already
  // arrived, so there is no server render for it to disagree with.
  const [reducedMotion] = useState(prefersReducedMotion);
  const [count, setCount] = useState(0);
  const countRef = useRef(0);

  useEffect(() => {
    if (reducedMotion) return;
    let frame = 0;
    let lastTs = 0;
    const loop = (ts: number) => {
      if (countRef.current >= text.length) return;
      const last = lastTs || ts;
      // Clamp large frame gaps (e.g. a backgrounded tab) so the reveal never
      // leaps the whole string on the first frame back.
      const dt = Math.min(0.05, (ts - last) / 1000);
      lastTs = ts;
      const remaining = text.length - countRef.current;
      const cps = Math.max(BASE_CHARS_PER_SECOND, remaining * 6);
      const advance = Math.max(1, Math.round(cps * dt));
      countRef.current = Math.min(text.length, countRef.current + advance);
      setCount(countRef.current);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [text, reducedMotion]);

  const displayed = reducedMotion ? text : text.slice(0, count);
  return (
    <AssistantMarkdown streaming={!reducedMotion && count < text.length}>
      {displayed}
    </AssistantMarkdown>
  );
}

"use client";
// Reveals an assistant reply a few characters at a time instead of snapping
// the whole string in at once. `ask_assistant` is one `kernelWrite`, not a
// stream, because rev1 ships no second transport (ARCHITECTURE.md §1.2,
// ADR-053). The full reply is already in hand when this mounts. This changes
// only how it is painted, the way `app_deprecated`'s `StreamingText` did for
// the chat surface it replaces.
//
// The flyout's transcript is a `role="log"` live region, and a reveal rewrites
// its text on every frame, which a screen reader would read out as fragments.
// So while it runs, the growing copy is `aria-hidden` and `inert`, and one
// visually hidden copy of the whole reply is what the region announces, once,
// on insertion. When the reveal ends, that copy is removed, and a live region
// does not announce a removal. The visual copy sits under `aria-live="off"`,
// so exposing it to assistive technology does not read the reply a second
// time.
//
// A reply reveals once. The flyout passes `reveal: false` for one that already
// finished, so returning to a workspace paints its transcript whole instead of
// retyping every answer in it.
//
// The flyout shows Stop until `onRevealed` fires (#4164), so every reveal it
// asks for reports its end, including one that reduced motion skipped. A
// reveal the flyout stops is handed the prefix already on screen as its text,
// and it ends there.
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  /** False for a reply that has already been revealed once: it paints whole. */
  reveal: boolean;
  /**
   * Called once, when the reveal has painted the last character, or at mount
   * when a reveal was asked for and reduced motion paints the reply whole.
   */
  onRevealed: () => void;
  /**
   * Called on every frame the reveal makes the reply taller, with the number
   * of characters now on screen. A stop keeps exactly that many.
   */
  onGrow: (shown: number) => void;
}

export function AssistantStreamingText({
  text,
  reveal,
  onRevealed,
  onGrow,
}: AssistantStreamingTextProps) {
  // Fixed at mount: this only ever mounts client-side, after a reply has
  // arrived, so there is no server render for it to disagree with, and a
  // `reveal` that flips to false when this instance finishes changes nothing.
  const [animate] = useState(() => reveal && !prefersReducedMotion());
  // A reveal asked for and not run has still ended. Without this the flyout
  // would wait on it, and show Stop, for as long as the reply stays open.
  const [skipped] = useState(() => reveal && !animate);
  const [count, setCount] = useState(0);
  const countRef = useRef(0);
  const grew = useEffectEvent(onGrow);
  const finished = useEffectEvent(onRevealed);

  useEffect(() => {
    if (skipped) finished();
  }, [skipped]);

  useEffect(() => {
    if (!animate) return;
    let frame = 0;
    let lastTs = 0;
    const loop = (ts: number) => {
      if (countRef.current >= text.length) {
        finished();
        return;
      }
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
      // Reported in the frame that paints the last character, not the next
      // one: a person who leaves the workspace in between would otherwise
      // come back to the whole reply typing itself out again.
      if (countRef.current >= text.length) {
        finished();
        return;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [text, animate]);

  // After React commits each frame's text, and before the browser paints it:
  // called from the frame loop, the caller would read the height the reply had
  // before this frame and scroll short of the tail.
  useLayoutEffect(() => {
    if (animate && count > 0) grew(count);
  }, [animate, count]);

  if (!animate) return <AssistantMarkdown>{text}</AssistantMarkdown>;

  const revealing = count < text.length;
  return (
    <>
      <div
        aria-live="off"
        aria-hidden={revealing || undefined}
        inert={revealing}
      >
        <AssistantMarkdown streaming={revealing}>
          {text.slice(0, count)}
        </AssistantMarkdown>
      </div>
      {revealing ? (
        <div className="sr-only" data-testid="assistant-answer-announced">
          <AssistantMarkdown interactive={false}>{text}</AssistantMarkdown>
        </div>
      ) : null}
    </>
  );
}

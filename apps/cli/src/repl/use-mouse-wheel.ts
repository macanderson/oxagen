/**
 * Best-effort SGR mouse-wheel reporting for the full-screen transcript
 * viewport. Attaches an ADDITIONAL `data` listener to the raw stdin stream
 * alongside Ink's own keypress listener — Node broadcasts `data` to every
 * registered listener, so this never steals bytes from (or races) Ink's
 * input handling — and forwards wheel-up/down ticks to `onWheel`. No-ops
 * when `enabled` is false or the terminal exposes no stdin (non-TTY).
 *
 * Escape-sequence arming/disarming (mode 1000/1006) lives in alt-screen.ts's
 * enableMouseReporting/disableMouseReporting, called from the same effect —
 * this hook is the single place that both arms reporting and listens for it,
 * so the two can never drift out of sync (armed-but-unheard, or heard but
 * never armed).
 */
import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import {
  enableMouseReporting,
  disableMouseReporting,
  parseMouseWheelEvents,
} from "./alt-screen.js";

export function useMouseWheel(
  onWheel: (direction: "up" | "down") => void,
  enabled: boolean,
): void {
  const { stdin, isRawModeSupported } = useStdin();
  // Mirrors the latest callback into a ref (same pattern as interactive.tsx's
  // modelRef/effortRef) so the effect below can stay subscribed to the SAME
  // stdin listener across renders — re-subscribing on every render churn
  // would repeatedly arm/disarm the mouse-tracking escape codes for no benefit.
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;

  useEffect(() => {
    if (!enabled || !stdin || !isRawModeSupported) return;
    const stream = process.stdout;
    enableMouseReporting(stream);
    const onData = (chunk: Buffer | string): void => {
      for (const e of parseMouseWheelEvents(String(chunk)))
        onWheelRef.current(e.direction);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      disableMouseReporting(stream);
    };
  }, [enabled, stdin, isRawModeSupported]);
}

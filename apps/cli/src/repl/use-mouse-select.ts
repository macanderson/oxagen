/**
 * Wires SGR mouse press/drag/release into the prompt input's click-to-
 * position / drag-to-select editing, scoped to a single terminal row (the
 * input's own content line).
 *
 * A pure LISTENER — does NOT arm/disarm SGR mouse tracking itself. That stays
 * use-mouse-wheel.ts's job (the single place that calls `enableMouseReporting`
 * / `disableMouseReporting`): two independent arm/disarm callers could race
 * on unmount and disable tracking the OTHER one still needs, so there's
 * exactly one owner of the escape codes and every other consumer — this hook
 * included — just listens. Attaches an ADDITIONAL stdin `data` listener
 * alongside Ink's own keypress listener and use-mouse-wheel.ts's wheel
 * listener — Node broadcasts `data` to every registered listener, so this
 * never steals bytes from (or races) either (see use-mouse-wheel.ts's
 * identical reasoning, which this mirrors closely).
 */
import { useEffect, useRef } from "react";
import { useStdin } from "ink";
import { parseMouseButtonEvents } from "./alt-screen.js";

export interface MouseSelectHandlers {
  /** A left-button press landed on the input's row — (re)start a selection at `col`. */
  onPress: (col: number) => void;
  /** Motion while the button is held, following an `onPress` on this input — extend the selection to `col`. */
  onDrag: (col: number) => void;
  /** The button was released — finalize whatever the drag produced. */
  onRelease: () => void;
}

/**
 * `row` is the 1-based terminal row the input's content line currently
 * renders at (see mouse-select.ts's `inputContentRow`); `undefined` disables
 * the hook entirely (classic/non-fullscreen mode, where mouse tracking isn't
 * armed at all, or an untracked layout). A press is only recognized when it
 * lands exactly on `row` — never steals a click meant for the transcript,
 * sidebar, or dock. Once that press starts a drag, subsequent drag/release
 * events are accepted REGARDLESS of row, so a fast drag that drifts a row
 * off the input mid-gesture never gets stuck or silently drops the
 * selection — only the column (clamped to the buffer's length by the caller)
 * still matters once dragging.
 */
export function useMouseSelect(
  handlers: MouseSelectHandlers,
  row: number | undefined,
  enabled: boolean,
): void {
  const { stdin, isRawModeSupported } = useStdin();
  // Mirrors use-mouse-wheel.ts's onWheelRef pattern: stay subscribed to the
  // SAME stdin listener across renders — re-subscribing on every keystroke/
  // streamed token would also reset the in-progress-drag tracking below,
  // silently dropping a drag mid-gesture.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled || !stdin || !isRawModeSupported || row === undefined) return;
    let dragging = false;
    const onData = (chunk: Buffer | string): void => {
      for (const e of parseMouseButtonEvents(String(chunk))) {
        const h = handlersRef.current;
        if (e.type === "press") {
          if (e.row !== row) continue; // not our row — belongs to the transcript/sidebar/dock
          dragging = true;
          h.onPress(e.col);
        } else if (e.type === "drag") {
          if (!dragging) continue; // motion with no press of ours behind it
          h.onDrag(e.col);
        } else {
          // release — always clear, regardless of row, so a lifted button
          // can never leave the drag stuck "active".
          if (dragging) h.onRelease();
          dragging = false;
        }
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [enabled, stdin, isRawModeSupported, row]);
}

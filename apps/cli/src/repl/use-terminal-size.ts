/**
 * Terminal geometry for the full-screen REPL.
 *
 * The REPL takes over the screen (alternate buffer) so the prompt bar can stay
 * pinned to the bottom edge while the transcript fills — and scrolls within —
 * the space above it. To keep the rendered frame bounded to the viewport (an
 * unbounded frame taller than the terminal is what garbled Ink's redraw in the
 * old inline model), the root box is sized to the live terminal rows/cols; this
 * hook is the source of those dimensions and tracks them across `resize`.
 *
 * `fullscreen` is false when stdout is not a TTY (tests, pipes): callers fall
 * back to an unbounded inline layout and skip the alternate-screen dance, so the
 * component stays trivially renderable under ink-testing-library.
 */
import { useStdout } from "ink";
import { useEffect, useState } from "react";

/** DECSET 1049: switch to the alternate screen buffer (and save the cursor). */
export const ENTER_ALT_SCREEN = "[?1049h";
/** DECRST 1049: restore the normal screen buffer (and the saved cursor). */
export const LEAVE_ALT_SCREEN = "[?1049l";
/** Move the cursor home — issued right after entering the alt buffer. */
export const CURSOR_HOME = "[H";

/** Fallback geometry when the terminal reports nothing (non-TTY / tests). */
const FALLBACK_ROWS = 24;
const FALLBACK_COLS = 80;

export interface TerminalSize {
  rows: number;
  cols: number;
  /** True only when attached to a real TTY — drives full-screen takeover. */
  fullscreen: boolean;
}

/**
 * Current terminal dimensions, re-read on every `resize`. Returns sane fallbacks
 * and `fullscreen: false` when there is no TTY so the caller renders inline.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const fullscreen = Boolean(stdout?.isTTY);
  const [size, setSize] = useState<{ rows: number; cols: number }>(() => ({
    rows: stdout?.rows ?? FALLBACK_ROWS,
    cols: stdout?.columns ?? FALLBACK_COLS,
  }));

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void =>
      setSize({
        rows: stdout.rows ?? FALLBACK_ROWS,
        cols: stdout.columns ?? FALLBACK_COLS,
      });
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return { rows: size.rows, cols: size.cols, fullscreen };
}

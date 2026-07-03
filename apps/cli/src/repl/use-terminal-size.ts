/**
 * Terminal geometry for the REPL.
 *
 * The REPL renders INLINE, in the terminal's normal screen buffer, so finished
 * output commits to the terminal's own scrollback and the user can scroll it
 * with a trackpad/mouse/Shift-PageUp exactly like any other normal-buffer
 * program. Only the small, in-progress live frame (the streaming message +
 * prompt bar + side panels) re-renders each tick; that frame is capped to the
 * live terminal row count so Ink's redraw never exceeds the viewport (an
 * unbounded frame taller than the terminal is what garbles Ink's cursor-based
 * redraw). This hook is the source of those dimensions and tracks them across
 * `resize`.
 *
 * `fullscreen` is false when stdout is not a TTY (tests, pipes): callers skip
 * the height cap and render an unbounded inline layout, so the component stays
 * trivially renderable under ink-testing-library.
 */
import { useStdout } from "ink";
import { useEffect, useState } from "react";

/** Fallback geometry when the terminal reports nothing (non-TTY / tests). */
const FALLBACK_ROWS = 24;
const FALLBACK_COLS = 80;

export interface TerminalSize {
  rows: number;
  cols: number;
  /** True only when attached to a real TTY — gates the live-frame height cap. */
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

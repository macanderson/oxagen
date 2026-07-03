/**
 * Raw terminal control for the REPL's full-screen mode: the alternate-screen
 * buffer, cursor visibility, and SGR extended mouse-wheel reporting. Plain
 * escape-sequence writes — no Ink, no React — so `launchRepl` can call this
 * before Ink ever mounts, and so every sequence is fully unit-testable
 * without a real terminal.
 *
 * This is the mirror image of the REPL's classic inline mode, which
 * deliberately never touches the alternate screen (see the regression guard
 * in __tests__/interactive.launch.test.tsx) so finished output can commit to
 * the terminal's own scrollback. Full-screen mode trades that native
 * scrollback for a bounded, app-owned viewport with its own in-app scroll
 * (see scroll.ts) — that trade is the whole point of this mode: a
 * space-efficient dashboard that fills the terminal exactly, which an inline
 * buffer can't do.
 */

// DECSET/DECRST 1049 — switch to / restore from the alternate screen buffer.
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
// DECTCEM — hide/show the terminal's own cursor (Ink draws its own where it belongs).
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// Mode 1000 (button-event mouse tracking) + 1006 (SGR extended coordinates,
// which never overflow into control bytes the way the legacy X10 encoding does).
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";

export interface FullscreenHandle {
  /** Restore the terminal to its normal state. Idempotent — safe to call more than once. */
  leave: () => void;
}

/**
 * Switches `stream` into the CLI's full-screen presentation: alternate
 * screen buffer + hidden cursor. Returns a handle whose `leave()` reverses
 * both, in the opposite order — call it on every exit path (normal
 * `waitUntilExit`, an uncaught error, `process.exit`) so a crash never
 * strands the user's terminal in the alternate buffer.
 */
export function enterFullscreen(stream: NodeJS.WriteStream): FullscreenHandle {
  stream.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    stream.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
  };
  return { leave };
}

/**
 * Arms SGR mouse-wheel reporting. A REACT-level concern (not part of
 * {@link enterFullscreen}) because it's user-toggleable at runtime (`/mouse
 * on|off`, `OXAGEN_CLI_MOUSE=0`) independent of full-screen mode itself — see
 * use-mouse-wheel.ts, which pairs this with a raw stdin listener.
 *
 * Mouse tracking can interfere with a terminal emulator's native text
 * selection (click-drag no longer selects text once the app owns clicks) —
 * that's exactly what the toggle is for; keyboard scroll always works
 * regardless of this setting.
 */
export function enableMouseReporting(stream: NodeJS.WriteStream): void {
  stream.write(ENABLE_MOUSE);
}

/** Disarms SGR mouse-wheel reporting — restores the terminal's normal click/selection behavior. */
export function disableMouseReporting(stream: NodeJS.WriteStream): void {
  stream.write(DISABLE_MOUSE);
}

export interface MouseWheelEvent {
  direction: "up" | "down";
}

// SGR mouse report: ESC [ < Cb ; Cx ; Cy (M|m)
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)[Mm]/g;

/**
 * Extracts wheel events from a raw stdin chunk. Bit 6 (64) marks a wheel
 * report; bit 0 distinguishes up (0) from down (1) — both bits are stable
 * across the modifier bits a terminal ORs in for shift/meta/ctrl (4/8/16), so
 * a modified scroll is never misread as a click. Non-wheel mouse reports
 * (clicks, drags, plain moves) are ignored — the viewport has no use for them.
 */
export function parseMouseWheelEvents(chunk: string): MouseWheelEvent[] {
  const events: MouseWheelEvent[] = [];
  for (const match of chunk.matchAll(SGR_MOUSE_RE)) {
    const cb = Number(match[1]);
    if (Number.isNaN(cb) || (cb & 64) === 0) continue;
    events.push({ direction: (cb & 1) === 1 ? "down" : "up" });
  }
  return events;
}

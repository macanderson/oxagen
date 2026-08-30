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
// Mode 1000 (press/release mouse tracking) + 1002 (ALSO reports motion while
// a button is held — the "drag" events prompt-input click-and-drag selection
// needs) + 1006 (SGR extended coordinates, which never overflow into control
// bytes the way the legacy X10 encoding does). 1002 is a superset of 1000 for
// click tracking in most terminals, but both are armed together to match how
// the common terminal apps that pioneered this (vim, tmux) do it — some
// emulators are stricter about wanting the "base" mode enabled too.
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

export interface FullscreenHandle {
  /** Restore the terminal to its normal state. Idempotent — safe to call more than once. */
  leave: () => void;
}

/**
 * Switches `stream` into the CLI's full-screen presentation: alternate
 * screen buffer + hidden cursor. Returns a handle whose `leave()` reverses
 * both, in the opposite order — call it on every exit path (normal
 * `waitUntilExit`, an uncaught error, `process.exit`, or a SIGTERM/SIGINT
 * handler — see launchRepl) so a crash or signal-kill never strands the
 * user's terminal.
 *
 * `leave()` ALSO disarms SGR mouse-wheel/click reporting (the same sequences
 * `disableMouseReporting` below writes), even though arming it is a separate,
 * React-level, user-toggleable concern (`/mouse`, `use-mouse-wheel.ts`) that
 * this module doesn't otherwise track. That React effect's own cleanup
 * disarms it on a clean unmount, but a signal-kill (SIGTERM/SIGINT) tears the
 * process down WITHOUT running React effect cleanups — the mouse-disable
 * escape sequence would simply never be written, leaving the user's terminal
 * stuck reporting raw SGR mouse escapes into their shell after the CLI exits.
 * Emitting the disable sequence here unconditionally is safe (idempotent) even
 * when mouse reporting was never armed in the first place.
 */
export function enterFullscreen(stream: NodeJS.WriteStream): FullscreenHandle {
  stream.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    stream.write(SHOW_CURSOR + DISABLE_MOUSE + LEAVE_ALT_SCREEN);
  };
  return { leave };
}

/**
 * Temporarily hand the terminal back to a child process (a blocking terminal
 * editor launched from the `/files` panel): restore the normal screen buffer
 * and cursor, and disarm mouse reporting so the editor sees clean input.
 * Pair with {@link resumeFullscreen} once the child exits. No-ops are safe —
 * the sequences are idempotent, same as `leave()` above.
 */
export function suspendFullscreen(stream: NodeJS.WriteStream): void {
  stream.write(SHOW_CURSOR + DISABLE_MOUSE + LEAVE_ALT_SCREEN);
}

/** Re-enter the alternate screen after {@link suspendFullscreen}. */
export function resumeFullscreen(stream: NodeJS.WriteStream): void {
  stream.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
}

/**
 * Arms SGR mouse-wheel reporting. A REACT-level concern (not part of
 * {@link enterFullscreen}) because it's opt-in and user-toggleable at runtime
 * (`/mouse`, or `OXAGEN_CLI_MOUSE=1` at launch — it defaults OFF so native
 * terminal text selection/copy keeps working) independent of full-screen mode
 * itself — see use-mouse-wheel.ts, which pairs this with a raw stdin listener.
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

// SGR mouse report: ESC [ < Cb ; Cx ; Cy (M|m) — shared format for wheel,
// press/drag, and release reports; parseMouseWheelEvents and
// parseMouseButtonEvents below each pick out the subset of reports they care
// about from the same byte stream (both are safe to run over every chunk).
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

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

export interface MouseButtonEvent {
  type: "press" | "drag" | "release";
  /** 1-based terminal column (SGR Cx) — matches cursor/editor column conventions. */
  col: number;
  /** 1-based terminal row (SGR Cy). */
  row: number;
}

/**
 * Extracts LEFT-BUTTON press/drag/release events from a raw stdin chunk —
 * what the prompt input's click-to-position-cursor / drag-to-select needs
 * (see use-mouse-select.ts). Requires mode 1002 to be armed (see
 * `ENABLE_MOUSE` above) for drag reports to arrive at all; press/release
 * alone would already flow under mode 1000.
 *
 * Ignores wheel reports (bit 6/64 — parseMouseWheelEvents's territory) and
 * any button other than the left one (bits 0-1 == 0) for press/drag — middle/
 * right clicks fall through to the terminal's own native handling rather than
 * becoming app-owned selection. Release reports are accepted regardless of
 * their button bits: some terminals preserve the released button's bits,
 * others always report 3 ("no button") on release, so gating on button 0
 * there would risk a drag that never finalizes on some emulators.
 */
export function parseMouseButtonEvents(chunk: string): MouseButtonEvent[] {
  const events: MouseButtonEvent[] = [];
  for (const match of chunk.matchAll(SGR_MOUSE_RE)) {
    const cb = Number(match[1]);
    const col = Number(match[2]);
    const row = Number(match[3]);
    if (Number.isNaN(cb) || Number.isNaN(col) || Number.isNaN(row)) continue;
    if ((cb & 64) !== 0) continue; // wheel report, not a button report

    if (match[4] === "m") {
      events.push({ type: "release", col, row });
      continue;
    }
    if ((cb & 3) !== 0) continue; // middle/right press or drag — not app-owned
    const isMotion = (cb & 32) !== 0;
    events.push({ type: isMotion ? "drag" : "press", col, row });
  }
  return events;
}

// ── Ink `useInput` quirk workaround ─────────────────────────────────────────
// Ink's own keypress parser has no concept of SGR mouse reports (see its
// parse-keypress.js): a report it doesn't recognize as a NAMED key (arrow,
// function key, …) falls through with an empty `key.name`, and its
// use-input.js then sets `input = keypress.sequence` and strips just the
// leading ESC byte — so EVERY wheel/press/drag/release report, having
// nowhere else to go, arrives at a `useInput` consumer's generic "insert
// whatever's left" catch-all as literal garbage text. Click-to-position makes
// this unavoidable: clicking the input is exactly when a report coincides with
// a focused text field. Ink provides no hook to suppress it upstream, so
// PromptInput filters the remnant out at its own `useInput` catch-all
// instead — see components.tsx.
const SGR_MOUSE_REPORT_REMNANT_RE = /^\[<\d+;\d+;\d+[Mm]$/;

/**
 * True when `input` is what's left of an SGR mouse report (`\x1b[<Cb;Cx;Cy(M|m)`)
 * after Ink's `useInput` strips its leading ESC byte — see the comment above.
 * Deliberately matches ANY Cb value (wheel bit set or not): the goal is
 * "never let this become literal text in an input", not "only recognize the
 * reports this app currently acts on".
 */
export function isStrayMouseReportRemnant(input: string): boolean {
  return SGR_MOUSE_REPORT_REMNANT_RE.test(input);
}

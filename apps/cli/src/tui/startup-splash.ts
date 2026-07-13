/**
 * Instant launch feedback for the interactive REPL.
 *
 * The REPL's real UI lives behind `import("./repl/interactive.js")`, whose
 * module graph (Ink + @oxagen/agent-engine + DuckDB/onnxruntime natives) can
 * take seconds to load cold — and much longer on a contended machine. Until it
 * resolves nothing is written to the terminal, so `oxagen` looks hung.
 *
 * This module is that gap's spinner: a raw-ANSI one-liner with ZERO heavy
 * dependencies (deliberately no Ink — loading Ink is part of the very work
 * being covered). program.tsx starts it the moment the REPL path is chosen and
 * stops it right before `launchRepl` takes over the screen, so the splash
 * frames never interleave with the REPL's alternate-screen buffer.
 *
 * Off a TTY (pipes, CI, tests) it is inert: not a single byte is written,
 * keeping scripted output byte-identical to before.
 */
import { theme } from "./theme.js";

const FRAME_MS = 80;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Rotating status lines; the last one sticks for long cold starts. */
const MESSAGES = [
  "waking the context engine…",
  "loading the agent engine…",
  "linking tools and skills…",
  "almost there…",
];
const MESSAGE_MS = 1500;
/** Start appending "(Ns)" once a launch is slow enough that seconds matter. */
const ELAPSED_AFTER_MS = 5000;

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\r\x1b[2K";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** `#RRGGBB` → truecolor foreground escape. */
function fg(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

export interface StartupSplash {
  /** Erase the splash line and restore the cursor. Safe to call twice. */
  stop(): void;
}

export interface StartupSplashOptions {
  /** Destination stream; defaults to process.stdout. Non-TTY ⇒ inert splash. */
  stream?: NodeJS.WriteStream;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Begin animating immediately (first frame is written synchronously, so even
 * a fully starved event loop shows *something*). Returns a handle whose
 * `stop()` clears the line — call it before any other UI touches the screen.
 */
export function startStartupSplash(
  options: StartupSplashOptions = {},
): StartupSplash {
  const stream = options.stream ?? process.stdout;
  if (!stream.isTTY) return { stop: () => {} };
  const now = options.now ?? Date.now;
  const color = !("NO_COLOR" in process.env);

  const startedAt = now();
  let frame = 0;
  let stopped = false;

  const paint = (): void => {
    const spin = SPINNER[frame % SPINNER.length];
    const msg =
      MESSAGES[
        Math.min(
          Math.floor((now() - startedAt) / MESSAGE_MS),
          MESSAGES.length - 1,
        )
      ];
    const elapsedMs = now() - startedAt;
    const elapsed =
      elapsedMs >= ELAPSED_AFTER_MS
        ? ` (${Math.round(elapsedMs / 1000)}s)`
        : "";
    const line = color
      ? `${CLEAR_LINE}${fg(theme.cyan)}${spin}${RESET} ${BOLD}${fg(theme.violet)}oxagen${RESET} ${DIM}${msg}${elapsed}${RESET}`
      : `${CLEAR_LINE}${spin} oxagen ${msg}${elapsed}`;
    stream.write(line);
    frame++;
  };

  stream.write(HIDE_CURSOR);
  paint();
  const timer = setInterval(paint, FRAME_MS);
  // Never keep the process alive on our account — the pending REPL import does
  // that; if it ever resolves to an exit instead, the splash must not block it.
  timer.unref();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
    },
  };
}

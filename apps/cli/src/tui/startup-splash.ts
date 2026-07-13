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
 *
 * Signals: the splash deliberately NEVER hides the cursor. During the import
 * window the event loop can be blocked for seconds at a stretch by synchronous
 * transforms (measured: one frame painted in 700ms under the tsx dev wrapper),
 * so a JS signal handler is not guaranteed to run before the process dies —
 * any terminal state that needs handler-based restoration WILL eventually be
 * stranded in the user's shell. Escapes are therefore limited to
 * clear-this-line, whose worst-case strand is a leftover text line. The
 * SIGINT/SIGTERM handlers below are best-effort polish for when the loop does
 * yield: clear the line, then re-raise (never `process.exit` — exit()-time C++
 * static destructors abort under native worker threads; see
 * lib/exit-by-signal.ts) so the shell still observes 128+n.
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

const CLEAR_LINE = "\r\x1b[2K";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** `#RRGGBB` → truecolor foreground escape. */
function fg(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

type SplashSignal = "SIGINT" | "SIGTERM";

/** The slice of `process` the splash needs for signal wiring (test seam). */
export interface SplashSignalSource {
  once(event: SplashSignal, listener: () => void): unknown;
  off(event: SplashSignal, listener: () => void): unknown;
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
  /** Signal source override for tests; defaults to `process`. */
  signals?: SplashSignalSource;
  /** Re-raise override for tests; defaults to `process.kill(process.pid, s)`. */
  raise?: (signal: SplashSignal) => void;
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
  const signals = options.signals ?? process;
  const raise =
    options.raise ??
    ((signal: SplashSignal): void => {
      process.kill(process.pid, signal);
    });
  // no-color.org: color is disabled only when NO_COLOR is set AND non-empty —
  // the same rule chalk/supports-color apply to the post-splash REPL, so an
  // empty NO_COLOR can't produce a colorless splash before a colorful REPL.
  const color = (process.env["NO_COLOR"] ?? "") === "";

  const startedAt = now();
  let frame = 0;
  let stopped = false;
  // `let` + guard: the first paint() runs before the interval exists, and its
  // failure path calls stop() — a `const timer` would be a TDZ crash there.
  let timer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    signals.off("SIGINT", onSigint);
    signals.off("SIGTERM", onSigterm);
    try {
      stream.write(CLEAR_LINE);
    } catch {
      // The stream died with the splash mid-flight (terminal closed) —
      // there is no terminal left to restore.
    }
  };

  // Clear the splash line BEFORE dying, then re-raise so the default action
  // (and the 128+n exit status) still applies — our `once` registration has
  // already removed us by the time the re-raised signal is delivered.
  const onSigint = (): void => {
    stop();
    raise("SIGINT");
  };
  const onSigterm = (): void => {
    stop();
    raise("SIGTERM");
  };

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
    try {
      stream.write(line);
    } catch {
      // A dead terminal mid-launch must not escalate to uncaughtException —
      // fall silent; the REPL import continues on its own.
      stop();
      return;
    }
    frame++;
  };

  paint();
  if (!stopped) {
    timer = setInterval(paint, FRAME_MS);
    // Never keep the process alive on our account — the pending REPL import
    // does that; if it resolves to an exit, the splash must not block it.
    timer.unref();
    signals.once("SIGINT", onSigint);
    signals.once("SIGTERM", onSigterm);
  }

  return { stop };
}

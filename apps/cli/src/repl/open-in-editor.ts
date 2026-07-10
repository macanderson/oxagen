/**
 * open-in-editor.ts — open a file in the user's default editor from the REPL.
 *
 * Resolution follows the git/lore convention: `$VISUAL` wins over `$EDITOR`;
 * with neither set, the platform opener (`open` / `cmd /c start` / `xdg-open`)
 * hands the file to the OS default application. Two launch modes:
 *
 *   • GUI editors + platform openers spawn DETACHED (fire-and-forget, stdio
 *     ignored, unref'd) — the same never-throw pattern as auth/open-browser.ts.
 *   • Terminal editors (vim, nano, …) must own the TTY that Ink currently
 *     holds in raw mode. The caller provides `suspendTui`/`resumeTui` hooks
 *     (leave the alt screen, drop raw mode) around a BLOCKING spawn with
 *     inherited stdio — the same trade `git commit` makes for its editor. The
 *     event loop halting while the editor is open is the point: nothing else
 *     may draw to the screen until the user quits it.
 *
 * `resolveEditorCommand` and the dispatch logic are pure/seam-injected so the
 * decision table is unit-testable without spawning anything.
 */
import { spawn, spawnSync } from "node:child_process";
import { basename } from "node:path";

/** A resolved editor invocation, before the file argument dispatches. */
export interface EditorCommand {
  /** Executable (or shell entry) to run. */
  file: string;
  /** Arguments INCLUDING the target file path (always last). */
  args: string[];
  /** True when this is a curses-style editor that must own the TTY. */
  terminal: boolean;
  /** Human label for notices, e.g. "vim" or "your default app". */
  label: string;
}

/**
 * Editors that run inside the terminal and therefore need the TTY handed
 * over. `emacs` is classified terminal-side: over SSH (where these CLIs live)
 * a GUI frame is the rare case, and `-nw` users are unambiguous.
 */
const TERMINAL_EDITORS = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "pico",
  "emacs",
  "micro",
  "helix",
  "hx",
  "kak",
  "joe",
  "ne",
  "vis",
  "mg",
]);

/**
 * Resolve how to open `filePath`: `$VISUAL` → `$EDITOR` → the platform
 * opener. Editor values are split on whitespace (covers `code --wait`,
 * `emacs -nw`); exotic quoted configurations are out of scope.
 */
export function resolveEditorCommand(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EditorCommand {
  const configured = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  if (configured !== "") {
    const tokens = configured.split(/\s+/);
    const file = tokens[0]!;
    const bin = basename(file);
    return {
      file,
      args: [...tokens.slice(1), filePath],
      terminal: TERMINAL_EDITORS.has(bin),
      label: bin,
    };
  }
  if (platform === "darwin") {
    return {
      file: "open",
      args: [filePath],
      terminal: false,
      label: "your default app",
    };
  }
  if (platform === "win32") {
    // `start` is a cmd builtin; the empty string is its window-title slot so a
    // path with spaces isn't mistaken for the title.
    return {
      file: "cmd",
      args: ["/c", "start", "", filePath],
      terminal: false,
      label: "your default app",
    };
  }
  return {
    file: "xdg-open",
    args: [filePath],
    terminal: false,
    label: "your default app",
  };
}

export type OpenInEditorResult =
  | { ok: true; label: string }
  | { ok: false; error: string };

/** Launch seams — real implementations below, fakes in tests. */
export interface OpenInEditorIo {
  /** Fire-and-forget GUI/opener launch. Must not throw. */
  spawnDetached?: (file: string, args: string[]) => void;
  /** Blocking terminal-editor launch with inherited stdio. */
  runBlocking?: (
    file: string,
    args: string[],
  ) => { status: number | null; error?: Error };
  /** Hand the TTY over before a blocking run (leave alt screen, raw mode off). */
  suspendTui?: () => void;
  /** Take the TTY back after a blocking run. */
  resumeTui?: () => void;
}

const defaultSpawnDetached = (file: string, args: string[]): void => {
  const child = spawn(file, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // Fire-and-forget: a missing binary surfaces via the returned notice
    // (best-effort), never as an unhandled 'error' event crash.
  });
  child.unref();
};

const defaultRunBlocking = (
  file: string,
  args: string[],
): { status: number | null; error?: Error } => {
  const res = spawnSync(file, args, { stdio: "inherit" });
  return { status: res.status, ...(res.error ? { error: res.error } : {}) };
};

/**
 * Open `filePath` in the resolved editor. GUI editors detach; terminal
 * editors run blocking between the caller's suspend/resume hooks. Never
 * throws — failures come back as `{ ok: false }` for a transcript notice.
 */
export function openInEditor(
  filePath: string,
  io: OpenInEditorIo = {},
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OpenInEditorResult {
  const cmd = resolveEditorCommand(filePath, env, platform);
  try {
    if (cmd.terminal) {
      const run = io.runBlocking ?? defaultRunBlocking;
      io.suspendTui?.();
      try {
        const { status, error } = run(cmd.file, cmd.args);
        if (error) return { ok: false, error: error.message };
        if (status !== 0 && status !== null) {
          return {
            ok: false,
            error: `${cmd.label} exited with status ${status}`,
          };
        }
      } finally {
        io.resumeTui?.();
      }
      return { ok: true, label: cmd.label };
    }
    (io.spawnDetached ?? defaultSpawnDetached)(cmd.file, cmd.args);
    return { ok: true, label: cmd.label };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

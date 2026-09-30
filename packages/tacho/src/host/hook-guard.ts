/**
 * A hook command that answers for itself when the collector is not
 * installed (ADR-230, #4298).
 *
 * Two harnesses block an action when a hook cannot run. Cursor's veto hooks
 * carry `failClosed: true`, which turns a crash, a timeout, a non-zero exit
 * or no output into a deny. Stella reads any non-zero exit as a deny. A
 * shell asked to run an executable that is not there exits 127, so when the
 * collector's executable is gone (the app bundle it lived in went to the
 * Trash, or someone deleted the per-user copy) every Cursor action and every
 * Stella tool call is refused, and nothing on the machine can answer to put
 * it right.
 *
 * `failClosed` is there for a collector that is installed and cannot
 * answer: a mandate that does not hold when the collector dies is no
 * mandate. A collector that is not installed enforces nothing, and blocking
 * every action does not make it enforce anything. So the Cursor and Stella
 * commands look for the executable first. When it is not there, the command
 * prints the answer the collector gives for an allow and exits 0. When it is
 * there, the command runs it, and its deny, crash or timeout still blocks.
 *
 * Deleting the executable is not a way around a mandate that deleting the
 * hooks file is not already. Both are files the same person owns.
 *
 * Claude Code and Codex treat an exit other than 0 or 2 as an error they
 * report and move past, so a missing executable costs them a warning on
 * each call and blocks nothing. Their commands are left as they are, and the
 * warning is the signal that the collector is gone.
 *
 * The test uses only the grammar every shell a harness runs hook commands
 * with on macOS and Linux shares: `sh`, `bash`, `zsh` and `fish` all read
 * `test ! -e <path> && ... && exit 0; exec <command>` the same way, and
 * none of them needs braces or `if`. A command for Windows is left as it
 * is: the harnesses there run hooks through different shells (`cmd.exe`
 * for Claude Code and Codex, `bash` for Stella), and no one test reads the
 * same in both. On Windows the per-user copy is the protection, since
 * removing the app leaves it in place.
 */

/** One word of a POSIX command line: as written, and as the shell reads it. */
export interface PosixWord {
  raw: string;
  value: string;
}

/** The characters `shellQuote` leaves unquoted on macOS and Linux. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]$/;

/**
 * The words of a command line that `shellQuote` could have written: bare
 * words of its safe characters, single-quoted spans, and a backslash before
 * one character (the `'\''` it writes for an apostrophe). Undefined for any
 * other syntax, so a command this cannot read is never wrapped.
 */
export function posixWords(line: string): PosixWord[] | undefined {
  const words: PosixWord[] = [];
  let raw = "";
  let value = "";
  const flush = () => {
    if (raw.length > 0) words.push({ raw, value });
    raw = "";
    value = "";
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c === " ") {
      flush();
      continue;
    }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return undefined;
      raw += line.slice(i, end + 1);
      value += line.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === "\\") {
      const next = line.charAt(i + 1);
      if (next === "") return undefined;
      raw += c + next;
      value += next;
      i += 1;
      continue;
    }
    if (!BARE.test(c)) return undefined;
    raw += c;
    value += c;
  }
  flush();
  return words;
}

/**
 * The word that names the collector's own executable in a hook command, as
 * written: the last word that is an absolute POSIX path. That is `tacho`
 * itself for the compiled binary (`'/…/tacho' hook`) and the script for the
 * Node layout (`/usr/bin/node /…/tacho-hook.mjs`). Undefined for a bare
 * program name, which a PATH lookup finds, for a Windows path, and for a
 * command `posixWords` cannot read.
 */
export function collectorExecutable(
  hookCommand: string,
): PosixWord | undefined {
  const words = posixWords(hookCommand);
  if (words === undefined) return undefined;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i] as PosixWord;
    if (word.value.startsWith("/")) return word;
  }
  return undefined;
}

/**
 * `command`, which runs `hookCommand` with its arguments, wrapped so that
 * when the collector's executable does not exist it prints `answer` (when
 * there is one) and exits 0. Unchanged when `hookCommand` names no
 * absolute POSIX executable (see `collectorExecutable`), when `command`
 * does not start with it, and when `answer` holds a `'` or a line break,
 * which would need quoting a `fish` shell reads differently.
 */
export function skipWhenCollectorAbsent(
  hookCommand: string,
  command: string,
  answer: string,
): string {
  if (!command.startsWith(hookCommand)) return command;
  if (/['\r\n]/.test(answer)) return command;
  const executable = collectorExecutable(hookCommand);
  if (executable === undefined) return command;
  const print = answer === "" ? "" : ` && printf '%s\\n' '${answer}'`;
  return `test ! -e ${executable.raw}${print} && exit 0; exec ${command}`;
}

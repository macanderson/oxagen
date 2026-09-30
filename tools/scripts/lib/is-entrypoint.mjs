/**
 * The one entrypoint test the guard scripts under `tools/scripts/` share.
 *
 * A guard runs its check only when node starts it, so that a test can import
 * its functions without running the check. The usual test,
 * `import.meta.url === new URL("file://" + process.argv[1]).href`, reads false
 * in two cases where node did start the script:
 *
 *   - Node resolves symlinks in the main module's URL but not in argv[1]. A
 *     checkout reached through a symlinked directory (macOS `/tmp` and `/var`,
 *     a symlinked worktree root) starts the script under one path and names
 *     it under another.
 *   - `import.meta.url` percent-encodes a space, `[`, or `#`, and argv[1] does
 *     not.
 *
 * For a guard, reading false is not a harmless miss. The script exits 0
 * having checked nothing, and the CI step or hook that ran it passes. The
 * test below compares real file paths, which both cases agree on.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether node was started on the module at `moduleUrl`.
 *
 * Pass the caller's own `import.meta.url`. A default here would be this
 * module's URL, which matches no caller.
 *
 * @param {string} moduleUrl the calling module's `import.meta.url`
 * @param {string | undefined} [argv1] the script node started, `process.argv[1]`
 * @returns {boolean}
 */
export function isEntrypoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

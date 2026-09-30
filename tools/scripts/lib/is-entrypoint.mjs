/**
 * is-entrypoint.mjs: whether node was started on a given module.
 *
 *   if (isEntrypoint(import.meta.url)) await main();
 *
 * A check script runs its body only when node starts it, so a test can import
 * its functions without running them. The usual comparison,
 * `import.meta.url === file://${process.argv[1]}`, fails in two ways, and each
 * one makes the script exit 0 having checked nothing, so its CI step passes
 * green:
 *
 * - Node resolves symlinks in the main module's URL but not in argv[1], so a
 *   checkout reached through a symlinked directory (macOS `/tmp`, a symlinked
 *   worktree root) never matches.
 * - `import.meta.url` percent-encodes a space, `[`, or `#`, and argv[1] does
 *   not, so a checkout under such a path never matches either.
 *
 * Comparing real file paths avoids both (#4664 item 1). Every script that
 * guards its body this way should call this one helper, so the fix cannot drift
 * between copies.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether `argv1`, the path node was started on, is the module at `moduleUrl`.
 * False when node was started with no script, or when either path is missing.
 *
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @param {string | null | undefined} [argv1] defaults to `process.argv[1]`
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

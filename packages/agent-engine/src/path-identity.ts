/**
 * One answer to "are these two strings the same file?".
 *
 * Several things in the agent key a guarantee on a path the model chose the
 * spelling of — the edit anchor that refuses a write against stale content, and
 * the file lock that stops two agents writing one file at once. Both were
 * keyed on the raw string, so `src/foo.ts`, `./src/foo.ts`, `src/../src/foo.ts`
 * and `src//foo.ts` were four different files, and in both cases a **miss is
 * not a refusal — it is a free pass** (#1357, #1358):
 *
 * - The anchor treats an absent entry as "never read this run, nothing to
 *   check", so a second spelling skips the stale-content check entirely.
 * - The lock treats a second spelling as a second resource, so both agents are
 *   granted, both write, and the last writer wins silently — the outcome the
 *   lock exists to make impossible.
 *
 * `resolveDisplayPath` is not this function and should not be used as one. It
 * joins a root and stops, which is right for echoing a resolved path back to
 * the model (its actual job) and wrong for identity. The local file-lock
 * adapter in `apps/cli` already normalized properly while the platform one did
 * not, so a fleet behaviour verified locally did not hold in production.
 *
 * What is deliberately NOT done here: case folding. macOS and Windows are
 * usually case-insensitive and Linux is not, so folding case would make two
 * genuinely different files on a Linux checkout share one lock. Identity stays
 * case-sensitive, which is the conservative direction — it can split one file
 * into two keys on a case-insensitive volume, where the failure is a redundant
 * check rather than a skipped one.
 *
 * Also deliberately NOT done: symlink resolution. `realpath` would make
 * `link/foo.ts` and `real/foo.ts` one key, and #1357 and #1358 both asked for
 * this to be decided rather than left to chance. It is declined, for two
 * reasons that are about the shape of this function rather than its cost:
 *
 * - It is pure and synchronous, and every caller is on a hot path that runs
 *   per read and per write. `realpath` is an I/O syscall, so taking it would
 *   make a file's identity depend on filesystem state at the moment of the
 *   call — two lookups either side of a `ln -s` would disagree.
 * - The key must exist for a file that does not. A write that creates a file
 *   anchors and locks before anything is on disk, and `realpath` on a missing
 *   path either throws or resolves only the prefix, so the one operation that
 *   most needs a stable key is the one it cannot produce.
 *
 * Unlike case folding, this residual does NOT fail in the safe direction, and
 * saying so is the point of writing it down: two spellings of one file that
 * differ only through a symlink stay two keys, and for the lock two keys means
 * both agents are granted. The exposure needs a workspace that reaches one
 * file through two paths differing by a symlink AND two agents on it at once;
 * how often that shape occurs in practice has not been measured, so treat the
 * bound as unknown rather than small. Closing it properly means moving
 * identity behind an async, I/O-taking port rather than adding a `realpath`
 * call here; that is a maintainer's call about this seam, not a line to slip
 * into it.
 */

/** `/abs`, `C:/abs` and `C:\abs` are absolute; everything else joins a root. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE.test(path);
}

/**
 * Collapse `.`, resolve `..`, and squash duplicate separators, keeping any
 * leading root (`/` or a drive) intact.
 */
function collapse(path: string): string {
  const slashed = path.replace(/\\/g, "/");

  let prefix = "";
  let body = slashed;
  const drive = /^([A-Za-z]:)\/?/.exec(slashed);
  if (drive) {
    prefix = `${drive[1]}/`;
    body = slashed.slice(drive[0].length);
  } else if (slashed.startsWith("/")) {
    prefix = "/";
    body = slashed.slice(1);
  }

  const out: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // At the root, `..` has nowhere to go; keep it for a relative path so
      // two genuinely different parents do not collapse onto each other.
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
        continue;
      }
      if (prefix !== "") continue;
      out.push("..");
      continue;
    }
    out.push(segment);
  }

  const joined = out.join("/");
  if (prefix !== "")
    return prefix === "/" ? `/${joined}` : `${prefix}${joined}`;
  return joined;
}

/**
 * The absolute identity of `path` as seen from `root` — the key anything
 * keyed on a file must use.
 */
export function canonicalPathKey(root: string, path: string): string {
  if (isAbsolute(path)) return collapse(path);
  const base = collapse(root);
  if (base === "" || base === "/") return `/${collapse(path)}`;
  return collapse(`${base}/${path}`);
}

/**
 * The identity of a path already relative to some root (a repository, say):
 * collapsed, with no leading separator, so `foo.ts`, `./foo.ts` and `/foo.ts`
 * are one key.
 */
export function canonicalRelativePathKey(path: string): string {
  const collapsed = collapse(path);
  return collapsed.startsWith("/") ? collapsed.slice(1) : collapsed;
}

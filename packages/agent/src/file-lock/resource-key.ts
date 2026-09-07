/**
 * Build the stable repository-scoped key used by file-lock leases.
 *
 * Repository coordinates avoid collisions between identical relative paths in
 * different repositories.
 *
 * The path is canonicalized first, because this key IS the lock's notion of
 * "the same file". It used to strip one leading separator and return the rest
 * verbatim — under a local variable called `normalizedPath`, which is the part
 * that would fool the next reader — so `src/foo.ts`, `./src/foo.ts` and
 * `src/../src/foo.ts` were three lease keys for one file on disk. Two turns
 * holding two of them were both granted, both wrote, and the last writer won
 * silently: the outcome the lock exists to make impossible (#1358).
 *
 * `canonicalPathKey`'s sibling is shared with the edit anchor
 * (`@oxagen/agent-engine`), which had the same defect one layer in (#1357), so
 * the two agree on identity by construction rather than by coincidence. The
 * local adapter in `apps/cli` already normalized; the platform one did not,
 * which meant a fleet behaviour verified locally did not hold in production.
 */
import { canonicalRelativePathKey } from "@oxagen/agent-engine";

export function toFileResourceKey(
  path: string,
  owner: string | undefined,
  repo: string | undefined,
): string {
  const canonical = canonicalRelativePathKey(path);
  if (owner && repo) {
    return `github:${owner}/${repo}:${canonical}`;
  }
  return canonical;
}

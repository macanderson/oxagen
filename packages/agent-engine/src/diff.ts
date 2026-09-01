/**
 * Reading a unified diff.
 *
 * The engine reports which files a turn touched by parsing the diff it already
 * computed, rather than trusting a tool to have announced every write: a turn
 * that shelled out through `bash` can change a file no tool event names.
 */
/** Parse `git diff` output for the set of changed file paths (`+++ b/<path>` headers). */
export function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const path = /^\+\+\+ b\/(.+)$/.exec(line)?.[1];
    if (path && path !== "/dev/null") files.add(path);
  }
  return [...files].sort();
}

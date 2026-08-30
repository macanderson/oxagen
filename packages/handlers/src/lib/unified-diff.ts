import { createTwoFilesPatch, diffLines, formatPatch, parsePatch } from "diff";

/**
 * One file's unified-diff patch body plus its added/removed line counts —
 * the shape `agent.repo.edit` / `repo.file.put` populate their optional
 * `diffs` output field with, and that `packages/oxagen/src/capability-meta.ts`
 * maps straight onto the `code-diff` chat card's `CodeDiffFile` props
 * (apps/app/src/components/chat/registry-components/code-diff-card.tsx).
 */
export interface FileDiff {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

/**
 * Build a unified diff (and add/del counts) for a single file's before →
 * after content. Mirrors packages/agent/src/handlers/code.diff.ts's approach
 * (jsdiff `createTwoFilesPatch` for the patch text, `diffLines` for stats) —
 * duplicated here rather than imported because that handler is
 * CapabilityHandler-shaped (bound to `(input, ctx)`) and this needs a plain
 * value function callable mid-handler, once per changed file.
 */
export function diffFileContents(
  path: string,
  before: string,
  after: string,
): FileDiff {
  const patch = createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    before,
    after,
    "",
    "",
  );
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count ?? 0;
    else if (part.removed) deletions += part.count ?? 0;
  }
  return { path, patch, additions, deletions };
}

/**
 * Split a combined multi-file unified/git diff (e.g. the sandbox workspace's
 * `git diff --cached` output) into one `FileDiff` per file.
 *
 * Uses jsdiff's `parsePatch`, which understands git's diff dialect (it
 * strips the `diff --git`/`index` extended headers and tracks
 * create/delete/rename), then re-serializes each file's `StructuredPatch`
 * back to unified-diff text via `formatPatch` so callers get the same flat
 * `{ path, patch, additions, deletions }` shape as `diffFileContents`.
 */
export function splitCombinedDiff(rawDiff: string): FileDiff[] {
  if (!rawDiff.trim()) return [];
  const patches = parsePatch(rawDiff);
  const results: FileDiff[] = [];
  for (const patch of patches) {
    const rawPath = patch.newFileName ?? patch.oldFileName ?? "";
    const path = rawPath.replace(/^[ab]\//, "");
    if (!path) continue;
    let additions = 0;
    let deletions = 0;
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions += 1;
        else if (line.startsWith("-")) deletions += 1;
      }
    }
    results.push({ path, patch: formatPatch(patch), additions, deletions });
  }
  return results;
}

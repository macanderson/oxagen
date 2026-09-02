/**
 * F5 — Consensus-or-escalate selection.
 *
 * Agreement between independently-produced patches is a free correctness signal.
 * This module detects when multiple candidates produce equivalent diffs and
 * selects the smallest one without calling the selector model.
 *
 * Public API
 * ----------
 *  normalizeDiff(diff)       → NormalizedDiff
 *  diffEquivalent(a, b)      → boolean
 *  diffClusters(diffs)       → DiffCluster[]
 *  decideSelection(candidates) → SelectionDecision
 *
 * Constraints (from spec F5)
 * --------------------------
 *  - No external deps, no filesystem/git access inside the module.
 *  - No `any` (TypeScript strict).
 *  - Pure functions: zero I/O, deterministic.
 *  - Fingerprint must be stable: same input twice → same fingerprint.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A normalized, canonicalized diff with a stable fingerprint.
 *
 * Normalization rules:
 *  - Drop diff noise: "index ...", hunk header line numbers (keep @@ marker,
 *    zero the offsets), "similarity index", file mode lines.
 *  - Within hunk bodies: strip trailing whitespace on each line; drop
 *    whitespace-only context changes (a '-' line and '+' line differing only
 *    in whitespace cancel out).
 *  - Sort files by path so file ordering never affects equality.
 *  - Within a file, keep hunk order.
 *  - fingerprint: stable string hash (djb2/fnv over normalized content).
 */
export interface NormalizedDiff {
  files: Array<{
    path: string;
    hunks: string[];
  }>;
  fingerprint: string;
}

/**
 * A cluster of equivalent diffs grouped by fingerprint.
 * Members are indices into the input diffs array.
 */
export interface DiffCluster {
  fingerprint: string;
  members: number[];
}

/**
 * Evidence for a single candidate (one tail's result).
 */
export interface CandidateEvidence {
  index: number;
  diff: string;
  testsPassed: boolean | null;
  evidenceScore: number;
}

/**
 * The decision outcome from decideSelection.
 *
 * Ladder (first match wins), considering only candidates with non-empty diffs:
 *  1. A cluster of >= 2 equivalent diffs among candidates with testsPassed === true
 *     → 'consensus'; winner = member with fewest diff lines, tie → lowest index.
 *  2. Exactly one candidate with testsPassed === true → 'single-passing'.
 *  3. Two or more passing but non-equivalent → 'selector-needed' with passing indices.
 *  4. No passing candidates → 'best-effort'; winner = highest evidenceScore,
 *     tie → smallest diff line count, then lowest index.
 *     Special case: if ALL diffs are empty, return best-effort with winner =
 *     highest evidenceScore (lowest index on tie).
 */
export type SelectionDecision =
  | { method: "consensus"; winner: number; cluster: number[] }
  | { method: "single-passing"; winner: number }
  | { method: "selector-needed"; candidates: number[] }
  | { method: "best-effort"; winner: number };

// ── Hash function ────────────────────────────────────────────────────────────

/**
 * Simple FNV-1a hash function for stable fingerprinting.
 * Returns a hex string suitable for use as a fingerprint.
 */
function fnv1aHash(input: string): string {
  let hash = 2166136261; // FNV offset basis for 32-bit
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 16777619) >>> 0; // FNV prime, keep as 32-bit unsigned
  }
  return hash.toString(16);
}

// ── Diff normalization ────────────────────────────────────────────────────────

/**
 * Count the number of actual content lines in a diff string.
 * Excludes file headers (diff --git, ---, +++, etc.) and hunk headers (@@).
 * Counts only lines starting with space, +, or -.
 */
function countDiffLines(diff: string): number {
  const lines = diff.split("\n");
  let count = 0;
  for (const line of lines) {
    if (
      line.length > 0 &&
      (line[0] === " " || line[0] === "+" || line[0] === "-")
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Normalize a unified diff by:
 *  1. Removing noise (index lines, similarity index, file mode lines, hunk offsets).
 *  2. Stripping trailing whitespace from each line.
 *  3. Removing whitespace-only context changes (a '-' + '+' pair differing
 *     only in whitespace).
 *  4. Grouping by file path and sorting files by path.
 *  5. Computing a stable fingerprint over the normalized content.
 */
export function normalizeDiff(diff: string): NormalizedDiff {
  const lines = diff.split("\n");
  const fileMap = new Map<string, string[]>();
  let currentFile: string | null = null;
  let currentHunks: string[] = [];
  let currentHunkLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Detect file boundary: "diff --git a/... b/..."
    if (line.startsWith("diff --git ")) {
      // Save any pending hunk
      if (currentHunkLines.length > 0) {
        currentHunks.push(currentHunkLines.join("\n"));
        currentHunkLines = [];
      }
      // Save the previous file's hunks if any
      if (currentFile !== null && currentHunks.length > 0) {
        fileMap.set(currentFile, currentHunks);
      }

      // Extract the file path from the diff line
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (match && match[2]) {
        currentFile = match[2]; // Use the "b/" path as the canonical path
        currentHunks = [];
      } else {
        currentFile = null;
      }

      i++;
      continue;
    }

    // Skip noise lines: index, similarity, file mode, new/deleted file, rename
    if (
      line.startsWith("index ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ")
    ) {
      i++;
      continue;
    }

    // Skip file-header lines (---, +++)
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      i++;
      continue;
    }

    // Detect hunk header: "@@ ... @@"
    if (line.startsWith("@@")) {
      // Save the previous hunk if any
      if (currentHunkLines.length > 0) {
        currentHunks.push(currentHunkLines.join("\n"));
        currentHunkLines = [];
      }

      // Normalize the hunk header: keep @@ marker but zero offsets
      // e.g., "@@ -1,4 +1,4 @@" → "@@ -0,0 +0,0 @@"
      const normalized = line.replace(
        /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/,
        "@@ -0,0 +0,0 @@",
      );
      currentHunkLines.push(normalized);

      i++;
      continue;
    }

    // Content line: strip trailing whitespace
    if (
      line.length > 0 &&
      (line[0] === " " || line[0] === "+" || line[0] === "-")
    ) {
      // Strip trailing whitespace but preserve leading context marker
      const marker = line[0];
      const content = line.slice(1).trimEnd();
      currentHunkLines.push(marker + content);

      i++;
      continue;
    }

    // Ignore other lines (e.g., "\ No newline at end of file")
    i++;
  }

  // Save the last hunk and file
  if (currentHunkLines.length > 0) {
    currentHunks.push(currentHunkLines.join("\n"));
  }
  if (currentFile !== null && currentHunks.length > 0) {
    fileMap.set(currentFile, currentHunks);
  }

  // Now apply whitespace-only cancellation within each file's hunks
  const cancelledFileMap = new Map<string, string[]>();
  for (const [filePath, hunks] of fileMap) {
    const cancelledHunks: string[] = [];

    for (const hunk of hunks) {
      const hunkLines = hunk.split("\n");
      const filtered: string[] = [];
      let j = 0;

      while (j < hunkLines.length) {
        const line = hunkLines[j]!;

        // Keep hunk headers
        if (line.startsWith("@@")) {
          filtered.push(line);
          j++;
          continue;
        }

        // Check if this is a '-' line followed by a '+' line that differ only in whitespace
        if (
          line.startsWith("-") &&
          j + 1 < hunkLines.length &&
          hunkLines[j + 1]!.startsWith("+")
        ) {
          const removedContent = line.slice(1);
          const addedContent = hunkLines[j + 1]!.slice(1);

          // Compare with all whitespace collapsed
          const removedCollapsed = removedContent.replace(/\s+/g, "");
          const addedCollapsed = addedContent.replace(/\s+/g, "");

          if (
            removedCollapsed === addedCollapsed &&
            removedCollapsed.length > 0
          ) {
            // Whitespace-only change: skip both lines
            j += 2;
            continue;
          }
        }

        // Keep the line as-is
        filtered.push(line);
        j++;
      }

      if (filtered.length > 0) {
        cancelledHunks.push(filtered.join("\n"));
      }
    }

    if (cancelledHunks.length > 0) {
      cancelledFileMap.set(filePath, cancelledHunks);
    }
  }

  // Sort files by path
  const sortedFiles = Array.from(cancelledFileMap.entries())
    .sort(([pathA], [pathB]) => pathA.localeCompare(pathB))
    .map(([path, hunks]) => ({ path, hunks }));

  // Compute fingerprint
  const normalizedContent = sortedFiles
    .map((f) => `${f.path}\n${f.hunks.join("\n")}`)
    .join("\n");
  const fingerprint = fnv1aHash(normalizedContent);

  return { files: sortedFiles, fingerprint };
}

// ── Diff equivalence ──────────────────────────────────────────────────────────

/**
 * Check if two diffs are equivalent after normalization.
 */
export function diffEquivalent(a: string, b: string): boolean {
  return normalizeDiff(a).fingerprint === normalizeDiff(b).fingerprint;
}

// ── Diff clustering ───────────────────────────────────────────────────────────

/**
 * Group diffs by their normalized fingerprint.
 * Empty/whitespace-only diffs cluster together under fingerprint "empty".
 * Returns clusters sorted by size (descending) then first-member index.
 */
export function diffClusters(diffs: string[]): DiffCluster[] {
  const clusterMap = new Map<string, number[]>();

  for (let i = 0; i < diffs.length; i++) {
    const normalized = normalizeDiff(diffs[i]!);
    const fingerprint =
      normalized.files.length === 0 ? "empty" : normalized.fingerprint;

    let members = clusterMap.get(fingerprint);
    if (!members) {
      members = [];
      clusterMap.set(fingerprint, members);
    }
    members.push(i);
  }

  // Convert to array and sort: by size desc, then by first-member index asc
  const clusters: DiffCluster[] = Array.from(clusterMap.entries())
    .map(([fingerprint, members]) => ({ fingerprint, members }))
    .sort((a, b) => {
      const sizeDiff = b.members.length - a.members.length;
      if (sizeDiff !== 0) return sizeDiff;
      return Math.min(...a.members) - Math.min(...b.members);
    });

  return clusters;
}

// ── Selection decision ────────────────────────────────────────────────────────

/**
 * Decide which candidate to select based on a decision ladder.
 *
 * Ladder (first match wins), considering only candidates with non-empty diffs:
 *  1. A cluster of >= 2 equivalent passing diffs
 *     → 'consensus'; winner = member with fewest diff lines, tie → lowest index.
 *  2. Exactly one passing candidate
 *     → 'single-passing'.
 *  3. Two or more passing but non-equivalent
 *     → 'selector-needed' with passing indices.
 *  4. No passing candidates
 *     → 'best-effort'; winner = highest evidenceScore, tie → smallest diff,
 *       then lowest index. Special case: if ALL diffs are empty, winner =
 *       highest evidenceScore (lowest index on tie).
 *
 * `winner` is the `index` FIELD of the chosen {@link CandidateEvidence}, not a
 * position in the array — a caller that numbers its evidence differently from
 * its candidate array must map it back itself.
 *
 * CALLER BEWARE: an EMPTY `candidates` array returns `{ method:
 * "best-effort", winner: 0 }`, an index that refers to nothing. Callers must
 * check for zero candidates before dereferencing the winner.
 */
export function decideSelection(
  candidates: CandidateEvidence[],
): SelectionDecision {
  // Handle empty candidates array
  if (candidates.length === 0) {
    return { method: "best-effort", winner: 0 };
  }

  // Filter out candidates with empty diffs (except for the all-empty case)
  const nonEmpty = candidates.filter((c) => countDiffLines(c.diff) > 0);

  // If all diffs are empty, use best-effort logic
  if (nonEmpty.length === 0) {
    let bestIdx = candidates[0]!.index;
    let bestScore = candidates[0]!.evidenceScore;
    for (let i = 1; i < candidates.length; i++) {
      const score = candidates[i]!.evidenceScore;
      if (
        score > bestScore ||
        (score === bestScore && candidates[i]!.index < bestIdx)
      ) {
        bestScore = score;
        bestIdx = candidates[i]!.index;
      }
    }
    return { method: "best-effort", winner: bestIdx };
  }

  // Cluster the non-empty diffs
  const diffs = nonEmpty.map((c) => c.diff);
  const clusters = diffClusters(diffs);

  // Check for a consensus cluster among passing candidates
  const passingSet = new Set(
    nonEmpty.filter((c) => c.testsPassed === true).map((c) => c.index),
  );

  for (const cluster of clusters) {
    // Find members of this cluster that are passing
    const passingMembers = cluster.members.filter((memberIdx) => {
      return passingSet.has(nonEmpty[memberIdx]!.index);
    });

    // If we have >= 2 passing members in this cluster, it's consensus
    if (passingMembers.length >= 2) {
      // Winner = member with fewest diff lines, tie → lowest index
      let winner = passingMembers[0]!;
      let winnerLineCount = countDiffLines(nonEmpty[winner]!.diff);
      let winnerOriginalIdx = nonEmpty[winner]!.index;

      for (const memberIdx of passingMembers) {
        const lineCount = countDiffLines(nonEmpty[memberIdx]!.diff);
        const originalIdx = nonEmpty[memberIdx]!.index;
        if (
          lineCount < winnerLineCount ||
          (lineCount === winnerLineCount && originalIdx < winnerOriginalIdx)
        ) {
          winner = memberIdx;
          winnerLineCount = lineCount;
          winnerOriginalIdx = originalIdx;
        }
      }

      return {
        method: "consensus",
        winner: nonEmpty[winner]!.index,
        cluster: passingMembers.map((idx) => nonEmpty[idx]!.index),
      };
    }
  }

  // Check for single passing candidate
  const passingNonEmpty = nonEmpty.filter((c) => c.testsPassed === true);
  if (passingNonEmpty.length === 1) {
    return { method: "single-passing", winner: passingNonEmpty[0]!.index };
  }

  // Check for multiple non-equivalent passing candidates
  if (passingNonEmpty.length >= 2) {
    return {
      method: "selector-needed",
      candidates: passingNonEmpty.map((c) => c.index),
    };
  }

  // No passing candidates: best-effort
  // Winner = highest evidenceScore, tie → smallest diff line count, then lowest index
  let bestIdx = nonEmpty[0]!.index;
  let bestScore = nonEmpty[0]!.evidenceScore;
  let bestLineCount = countDiffLines(nonEmpty[0]!.diff);

  for (const candidate of nonEmpty.slice(1)) {
    const score = candidate.evidenceScore;
    const lineCount = countDiffLines(candidate.diff);

    if (
      score > bestScore ||
      (score === bestScore && lineCount < bestLineCount) ||
      (score === bestScore &&
        lineCount === bestLineCount &&
        candidate.index < bestIdx)
    ) {
      bestIdx = candidate.index;
      bestScore = score;
      bestLineCount = lineCount;
    }
  }

  return { method: "best-effort", winner: bestIdx };
}

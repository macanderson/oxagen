/**
 * F6 — Deterministic diff shrinker.
 *
 * Greedy reverse delta-debugging: given a patch that passes an oracle, try
 * dropping whole files first, then individual hunks.  Keep the minimal subset
 * that still passes.  Zero LLM tokens; the oracle callback owns execution.
 *
 * Public API
 * ----------
 *  parsePatch(diff)              → Hunk[]
 *  renderPatch(hunks)            → string
 *  shrink(patch, oracle, opts?)  → Promise<ShrinkResult>
 *
 * Constraints (from spec F6)
 * --------------------------
 *  - No external deps, no filesystem/git access inside the module.
 *  - No `any` (TypeScript strict).
 *  - Default maxOracleRuns = 12.
 *  - Skip shrinking (return original, reduced:false) when total hunks ≤ 2.
 *  - Never drop hunks touching protectedPaths.
 *  - Never-worse guarantee: final patch MUST have passed the oracle.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single hunk from a unified diff, together with the file-header lines that
 * precede the first hunk of that file (so we can reconstruct a valid patch).
 */
export interface Hunk {
  /** e.g. "a/src/foo.ts" */
  readonly fromPath: string;
  /** e.g. "b/src/foo.ts" */
  readonly toPath: string;
  /**
   * The canonical path for this hunk (used for protectedPaths matching).
   * Derived from toPath (strips the "b/" prefix) or fromPath for deletes.
   */
  readonly filePath: string;
  /**
   * The `diff --git …` + `--- …` + `+++ …` header lines that open the file
   * section.  Shared by all hunks of the same file; stored on every hunk so
   * each hunk is self-contained for rendering.
   */
  readonly fileHeader: string;
  /**
   * The raw `@@ … @@` hunk text including the hunk header line and all
   * context/added/removed lines.
   */
  readonly raw: string;
  /** Index of this hunk within its file (0-based). */
  readonly hunkIndex: number;
}

export interface ShrinkResult {
  /** The reduced (or original) patch string. */
  patch: string;
  /** Number of hunks dropped. */
  dropped: number;
  /** Number of hunks kept. */
  kept: number;
  /** Total oracle invocations used. */
  oracleRuns: number;
  /** Whether the patch was actually reduced. */
  reduced: boolean;
}

// ── parsePatch ────────────────────────────────────────────────────────────────

/**
 * Parse a unified git diff into an array of {@link Hunk} objects.
 *
 * Handles:
 *  - Multi-file diffs
 *  - New-file markers (`new file mode …`)
 *  - Deleted-file markers (`deleted file mode …`)
 *  - Rename markers (`rename from … / rename to …`)
 *  - Binary-file entries (no hunk lines — produces zero hunks for that file)
 */
export function parsePatch(diff: string): Hunk[] {
  const lines = diff.split("\n");
  const hunks: Hunk[] = [];

  let i = 0;
  while (i < lines.length) {
    // Find the start of a file section: "diff --git a/… b/…"
    if (!lines[i]!.startsWith("diff --git ")) {
      i++;
      continue;
    }

    // Collect the file header until the first hunk line ("@@ …") or the next
    // "diff --git" line.
    const headerStart = i;
    let fromPath = "";
    let toPath = "";
    let filePath = "";

    // Parse paths from "diff --git a/<from> b/<to>"
    const gitLine = lines[i]!;
    const gitMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(gitLine);
    if (gitMatch) {
      fromPath = `a/${gitMatch[1]}`;
      toPath = `b/${gitMatch[2]}`;
      // Default filePath from toPath; overridden below for renames/deletes.
      filePath = gitMatch[2]!;
    }

    i++;

    // Scan extended header lines (mode, new file, deleted file, rename, etc.)
    while (i < lines.length && !lines[i]!.startsWith("diff --git ") && !lines[i]!.startsWith("@@")) {
      const line = lines[i]!;

      if (line.startsWith("rename from ")) {
        fromPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        toPath = line.slice("rename to ".length);
        filePath = toPath;
      } else if (line.startsWith("--- ")) {
        // "--- a/path" or "--- /dev/null"
        const p = line.slice(4);
        if (p !== "/dev/null") fromPath = p;
      } else if (line.startsWith("+++ ")) {
        // "+++ b/path" or "+++ /dev/null"
        const p = line.slice(4);
        if (p !== "/dev/null") {
          toPath = p;
          // Strip "b/" prefix for the logical filePath
          filePath = p.startsWith("b/") ? p.slice(2) : p;
        } else {
          // Deleted file: use fromPath for filePath
          filePath = fromPath.startsWith("a/") ? fromPath.slice(2) : fromPath;
        }
      }

      i++;
    }

    const fileHeader = lines.slice(headerStart, i).join("\n");

    // Collect hunks for this file
    let hunkIndex = 0;
    while (i < lines.length && lines[i]!.startsWith("@@")) {
      const hunkStart = i;
      i++; // consume the @@ line
      // Consume body lines: context (space), added (+), removed (-), or
      // "\ No newline at end of file"
      while (
        i < lines.length &&
        !lines[i]!.startsWith("@@") &&
        !lines[i]!.startsWith("diff --git ")
      ) {
        i++;
      }
      const raw = lines.slice(hunkStart, i).join("\n");
      hunks.push({ fromPath, toPath, filePath, fileHeader, raw, hunkIndex });
      hunkIndex++;
    }
  }

  return hunks;
}

// ── renderPatch ───────────────────────────────────────────────────────────────

/**
 * Render a subset of {@link Hunk} objects back into a valid unified diff
 * string.  Round-trip safe: `renderPatch(parsePatch(d))` produces a patch that
 * applies identically to the original for all kept hunks.
 *
 * Hunks that belong to the same file are grouped under a single file header.
 */
export function renderPatch(hunks: Hunk[]): string {
  if (hunks.length === 0) return "";

  // Group hunks by fileHeader (preserves original file order implicitly since
  // parsePatch emits them in order).
  const seen = new Map<string, Hunk[]>();
  for (const hunk of hunks) {
    let group = seen.get(hunk.fileHeader);
    if (!group) {
      group = [];
      seen.set(hunk.fileHeader, group);
    }
    group.push(hunk);
  }

  const parts: string[] = [];
  for (const [header, group] of seen) {
    parts.push(header);
    for (const hunk of group) {
      parts.push(hunk.raw);
    }
  }

  // Join with newlines; each section already ends without a trailing newline
  // because split("\n") consumed them.
  return parts.join("\n");
}

// ── shrink ────────────────────────────────────────────────────────────────────

export interface ShrinkOptions {
  /** Maximum number of oracle invocations.  Default 12. */
  maxOracleRuns?: number;
  /**
   * Paths that must never be dropped.  Any hunk whose `filePath` contains one
   * of these strings is protected (file-path overlap heuristic from spec F6).
   */
  protectedPaths?: string[];
}

/**
 * Greedy reverse delta-debugging shrinker.
 *
 * Strategy
 * --------
 * 1. Try dropping all hunks for each file in turn (whole-file drops first).
 * 2. Then try dropping each remaining hunk individually.
 * 3. After each successful drop, continue from the new reduced set.
 * 4. Stop when the oracle budget is exhausted.
 *
 * Invariants
 * ----------
 * - The oracle is only called with candidates that differ from the current
 *   best (no redundant calls).
 * - If the oracle throws, the exception is swallowed and the candidate is
 *   treated as failing (never-worse guarantee).
 * - The returned patch has always passed the oracle (or is the original if
 *   nothing could be dropped).
 */
export async function shrink(
  patch: string,
  oracle: (candidate: string) => Promise<boolean>,
  opts?: ShrinkOptions,
): Promise<ShrinkResult> {
  const maxOracleRuns = opts?.maxOracleRuns ?? 12;
  const protectedPaths = opts?.protectedPaths ?? [];

  const allHunks = parsePatch(patch);
  const totalHunks = allHunks.length;

  // Skip shrinking when too few hunks.
  if (totalHunks <= 2) {
    return {
      patch,
      dropped: 0,
      kept: totalHunks,
      oracleRuns: 0,
      reduced: false,
    };
  }

  let oracleRuns = 0;
  let current: Hunk[] = allHunks.slice();

  /**
   * Helper: call the oracle with a candidate hunk set.  Returns false on
   * throw (never-worse guarantee).
   */
  async function tryOracle(candidate: Hunk[]): Promise<boolean> {
    oracleRuns++;
    const candidatePatch = renderPatch(candidate);
    try {
      return await oracle(candidatePatch);
    } catch {
      return false;
    }
  }

  /** Return true if a hunk is protected (must never be dropped). */
  function isProtected(hunk: Hunk): boolean {
    if (protectedPaths.length === 0) return false;
    return protectedPaths.some(
      (p) =>
        hunk.filePath.includes(p) ||
        hunk.fromPath.includes(p) ||
        hunk.toPath.includes(p),
    );
  }

  // ── Phase 1: whole-file drops ────────────────────────────────────────────

  // Collect unique file headers in the order they appear.
  const fileHeaders: string[] = [];
  for (const h of current) {
    if (!fileHeaders.includes(h.fileHeader)) fileHeaders.push(h.fileHeader);
  }

  for (const header of fileHeaders) {
    if (oracleRuns >= maxOracleRuns) break;

    // Check if any hunk in this file is protected.
    const fileHunks = current.filter((h) => h.fileHeader === header);
    if (fileHunks.some((h) => isProtected(h))) continue;

    // Candidate: drop all hunks for this file.
    const candidate = current.filter((h) => h.fileHeader !== header);
    if (candidate.length === 0) continue; // never produce an empty patch

    const ok = await tryOracle(candidate);
    if (ok) {
      current = candidate;
    }
  }

  // ── Phase 2: individual hunk drops ──────────────────────────────────────

  // Iterate over a snapshot of the current hunk list; re-check membership
  // since previous drops may have already removed some.
  const snapshot = current.slice();
  for (const hunk of snapshot) {
    if (oracleRuns >= maxOracleRuns) break;
    if (!current.includes(hunk)) continue; // already dropped
    if (isProtected(hunk)) continue;

    const candidate = current.filter((h) => h !== hunk);
    if (candidate.length === 0) continue; // never produce an empty patch

    const ok = await tryOracle(candidate);
    if (ok) {
      current = candidate;
    }
  }

  const dropped = totalHunks - current.length;
  const reduced = dropped > 0;

  return {
    patch: reduced ? renderPatch(current) : patch,
    dropped,
    kept: current.length,
    oracleRuns,
    reduced,
  };
}

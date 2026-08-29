/**
 * Mutation verifier — the pure core (no I/O).
 *
 * "Verify tests pass for the RIGHT reason", as a physical law of the harness:
 * after the agent produces fix + tests and the judge calls the turn complete,
 * the gate reverts the fix (and only the fix — test files stay in place),
 * re-runs the test command the agent itself used as evidence, and demands a
 * FAILURE. A test that still passes without the fix witnesses nothing — the
 * turn is vacuous and gets sent back through the existing revise loop before
 * the user ever sees a false green.
 *
 * This module is the deterministic half: unified-diff parsing, reverse
 * reconstruction of pre-fix file contents, test/source partitioning, witness
 * command planning, single-line mutant generation (layer 2), and the verdict
 * override. All functions are pure so they hit the package's 90% coverage
 * gate without filesystem fixtures. The I/O half (snapshot / revert / run /
 * restore against the {@link Workspace} port) lives in ./gate.ts.
 *
 * Fail-open philosophy: only a CLEAN "reverted the fix and the tests still
 * passed" produces a rejection. Anything the gate cannot do faithfully —
 * unparseable diff segment, rename, binary file, missing hunk context — makes
 * it step aside with status "skipped" and a reason. A verifier that could
 * reject on its own infrastructure noise would train users to disable it.
 */
import { isTestPath } from "../tools-shared";

// ── Diff parsing ───────────────────────────────────────────────────────────────

/** One hunk of a unified diff. `lines` keep their +/-/space prefix. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** One file's segment of a unified diff. */
export interface DiffFile {
  /** Repo-relative path (the `b/` side; `a/` side for deletions). */
  path: string;
  kind: "modified" | "created" | "deleted";
  hunks: DiffHunk[];
  /** Set when the segment can't be faithfully reverted (rename, binary, …). */
  unsupported?: string;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Strip the `a/` / `b/` prefix git puts on diff paths. */
function stripDiffPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

/**
 * Parse a `git diff`-style unified diff into per-file segments. Tolerates both
 * full `diff --git` segments and bare `---`/`+++` pairs. Segments that cannot
 * be faithfully reverse-applied (renames, binary patches, quoted paths,
 * missing-trailing-newline markers, hunkless bodies) are kept but marked
 * `unsupported` so the gate can refuse to guess.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!diff.trim()) return files;

  // Closes a segment: hunkless bodies can't be reverse-applied, so mark them.
  const finalize = (f: DiffFile | null): void => {
    if (!f) return;
    if (!f.unsupported && f.hunks.length === 0) {
      f.unsupported = "segment has no hunks";
    }
    files.push(f);
  };

  const lines = diff.split("\n");
  let current: DiffFile | null = null;
  let oldPath = "";
  let newPath = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (line.startsWith("diff --git ")) {
      finalize(current);
      current = { path: "", kind: "modified", hunks: [] };
      oldPath = "";
      newPath = "";
      if (line.includes('"')) current.unsupported = "quoted path";
      continue;
    }
    if (line.startsWith("--- ")) {
      // A bare ---/+++ pair (no `diff --git` header) also opens a segment.
      if (!current || newPath !== "") {
        finalize(current);
        current = { path: "", kind: "modified", hunks: [] };
        oldPath = "";
        newPath = "";
      }
      oldPath = line.slice(4).trim();
      if (oldPath.startsWith('"')) current.unsupported = "quoted path";
      continue;
    }
    if (!current) continue;

    if (line.startsWith("+++ ")) {
      newPath = line.slice(4).trim();
      if (newPath.startsWith('"')) current.unsupported = "quoted path";
      if (newPath === "/dev/null") {
        current.kind = "deleted";
        current.path = stripDiffPrefix(oldPath);
      } else {
        if (oldPath === "/dev/null") current.kind = "created";
        current.path = stripDiffPrefix(newPath);
      }
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      current.unsupported = "rename";
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.unsupported = "binary file";
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      // Faithful reverse-application with asymmetric trailing newlines is
      // subtle; V1 refuses rather than risking a corrupted restore.
      current.unsupported = "missing trailing newline";
      continue;
    }

    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk) {
      current.hunks.push({
        oldStart: Number(hunk[1]),
        oldLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        newStart: Number(hunk[3]),
        newLines: hunk[4] === undefined ? 1 : Number(hunk[4]),
        lines: [],
      });
      continue;
    }
    const active = current.hunks[current.hunks.length - 1];
    if (
      active &&
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))
    ) {
      active.lines.push(line);
    }
  }
  finalize(current);
  return files;
}

/** Split parsed diff files into test files and source (non-test) files. */
export function partitionByTestPath(files: DiffFile[]): {
  testFiles: DiffFile[];
  sourceFiles: DiffFile[];
} {
  const testFiles: DiffFile[] = [];
  const sourceFiles: DiffFile[] = [];
  for (const f of files) (isTestPath(f.path) ? testFiles : sourceFiles).push(f);
  return { testFiles, sourceFiles };
}

// ── Reverse reconstruction ─────────────────────────────────────────────────────

/** Lines of one side of a hunk, prefixes stripped. */
function hunkSide(hunk: DiffHunk, side: "old" | "new"): string[] {
  const keep = side === "old" ? "-" : "+";
  const out: string[] = [];
  for (const l of hunk.lines) {
    const c = l[0];
    if (c === " " || c === keep) out.push(l.slice(1));
  }
  return out;
}

/**
 * Reconstruct a file's PRE-FIX content from its CURRENT (post-fix) content and
 * its diff segment, by reverse-applying hunks.
 *
 * Returns:
 * - a string — the original content (for "modified" and "deleted" segments);
 * - `null` — the file did not exist before the fix ("created" segments);
 * - `undefined` — reconstruction is impossible (unsupported segment, or the
 *   current content no longer matches the diff's new side, e.g. something
 *   else touched the file after the diff was taken). The gate must skip.
 */
export function reconstructOriginal(
  file: DiffFile,
  currentContent: string | null,
): string | null | undefined {
  if (file.unsupported) return undefined;
  if (file.kind === "created") return null;

  if (file.kind === "deleted") {
    // A deletion diff carries the whole original file on its old side.
    const only = file.hunks[0];
    if (!only || file.hunks.length !== 1 || currentContent !== null)
      return undefined;
    return hunkSide(only, "old").join("\n") + "\n";
  }

  if (currentContent === null) return undefined;
  const hadTrailingNewline = currentContent.endsWith("\n");
  const lines = currentContent.split("\n");
  if (hadTrailingNewline) lines.pop();

  // Apply from the LAST hunk up so earlier splices don't shift later offsets.
  for (let h = file.hunks.length - 1; h >= 0; h--) {
    const hunk = file.hunks[h]!;
    const newSide = hunkSide(hunk, "new");
    const oldSide = hunkSide(hunk, "old");
    const at = hunk.newStart - 1;
    if (at < 0 || at + newSide.length > lines.length) return undefined;
    for (let i = 0; i < newSide.length; i++) {
      if (lines[at + i] !== newSide[i]) return undefined;
    }
    lines.splice(at, newSide.length, ...oldSide);
  }
  return lines.join("\n") + (hadTrailingNewline ? "\n" : "");
}

// ── Witness planning ───────────────────────────────────────────────────────────

/** Everything the gate needs to know about the turn's executed test evidence. */
export interface TestEvidence {
  /** Latest exit code per normalized test-like command (SpecTestTracker.lastOutcomes). */
  lastOutcomes: Map<string, number>;
  /** The command that flipped fail→pass this turn, if any (SpecTestTracker.flippedBy). */
  flippedBy: string | null;
}

/**
 * Pick the commands whose re-run (without the fix) must fail: currently-passing
 * test-like commands, the fail→pass flip first — it is the agent's own claimed
 * witness. Capped so a command-happy turn can't turn the gate into a suite run.
 */
export function planWitnessCommands(
  evidence: TestEvidence,
  maxCommands: number,
): string[] {
  const passing: string[] = [];
  for (const [cmd, exit] of evidence.lastOutcomes) {
    if (exit === 0) passing.push(cmd);
  }
  const ordered =
    evidence.flippedBy !== null && passing.includes(evidence.flippedBy)
      ? [evidence.flippedBy, ...passing.filter((c) => c !== evidence.flippedBy)]
      : passing;
  return ordered.slice(0, Math.max(0, maxCommands));
}

/**
 * Whether the turn makes a witness CLAIM the gate is entitled to check: either
 * a test went fail→pass (the spec-test oracle flipped) or the turn changed
 * test files. Without a claim the gate stays silent — a turn that never
 * claimed to be test-witnessed should not be rejected for lacking one.
 */
export function hasWitnessClaim(
  evidence: TestEvidence,
  testFilesChanged: number,
): boolean {
  return evidence.flippedBy !== null || testFilesChanged > 0;
}

// ── Gate result ────────────────────────────────────────────────────────────────

/** One witness command's re-run outcome in the fix-reverted shadow. */
export interface WitnessRun {
  command: string;
  /** Exit code without the fix; null when the run timed out. */
  exitCode: number | null;
  timedOut: boolean;
}

/** Layer 2: patch-scoped mutation-testing score. */
export interface MutationScore {
  mutantsTried: number;
  mutantsKilled: number;
  /** 0–1; 1 means every mutant of the fix was caught by the tests. */
  killRate: number;
  survivors: Array<{ path: string; line: number; description: string }>;
}

export type MutationGateStatus = "witnessed" | "vacuous" | "skipped";

/** The gate's full verdict for one judged-complete round. */
export interface MutationGateResult {
  status: MutationGateStatus;
  /** Human-readable one-liner: why this status. */
  reason: string;
  /** Witness command re-runs performed in the fix-reverted shadow. */
  runs: WitnessRun[];
  /** Source files reverted in the shadow (repo-relative). */
  revertedFiles: string[];
  /** Test files the turn changed (kept in place during the revert). */
  testFiles: string[];
  durationMs: number;
  /** Present when layer 2 (mutation scoring) ran. */
  score?: MutationScore;
}

/** True when at least one witness re-run failed — the tests DO witness the fix. */
export function witnessOutcome(runs: WitnessRun[]): "witnessed" | "vacuous" {
  return runs.some(
    (r) => r.timedOut || (r.exitCode !== null && r.exitCode !== 0),
  )
    ? "witnessed"
    : "vacuous";
}

// ── Verdict override ───────────────────────────────────────────────────────────

/** The judge-verdict fields the gate needs to override. */
export interface GateableVerdict {
  complete: boolean;
  findings: string[];
  remainingWork: string[];
  reasoning: string;
}

/**
 * Fold a vacuous gate result into the judge's verdict so the EXISTING revise
 * loop drives the correction — the gate never invents its own control flow.
 * Witnessed/skipped results leave the verdict untouched.
 */
export function applyGateToVerdict<V extends GateableVerdict>(
  verdict: V,
  gate: MutationGateResult,
): V {
  if (gate.status !== "vacuous") return verdict;
  const commandList = gate.runs.map((r) => `\`${r.command}\``).join(", ");
  const finding =
    `Mutation gate: the fix was reverted in a shadow and the test evidence still passed ` +
    `(${commandList || "no witness command"}). The tests do not witness the fix — ` +
    `either the fix is a no-op or the tests are vacuous.`;
  return {
    ...verdict,
    complete: false,
    findings: [...verdict.findings, finding],
    remainingWork: [
      ...verdict.remainingWork,
      "Write (or repair) a test that FAILS without the fix and passes with it, then re-run it both ways.",
    ],
    reasoning:
      verdict.reasoning +
      "\n[mutation gate] Overrode 'complete': reverting the fix did not make the witness tests fail.",
  };
}

/**
 * Resolve whether the gate is enabled: an explicit option always wins; else the
 * OXAGEN_MUTATION_VERIFY env var; else ON — it is a default law of the harness,
 * not an opt-in feature.
 */
export function resolveMutationVerifyEnabled(
  env: Record<string, string | undefined>,
  option?: boolean,
): boolean {
  if (option !== undefined) return option;
  const raw = env["OXAGEN_MUTATION_VERIFY"];
  if (raw === undefined) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

// ── Layer 2: mutant generation ─────────────────────────────────────────────────

export interface Mutant {
  path: string;
  /** 1-based line number in the CURRENT (fixed) file. */
  line: number;
  description: string;
  /** Full file content with exactly this one mutation applied. */
  mutatedContent: string;
}

/** Deterministic single-token mutation operators, applied first-match. */
const MUTATION_OPERATORS: Array<{
  find: RegExp;
  replace: string;
  label: string;
}> = [
  { find: /===/, replace: "!==", label: "=== → !==" },
  { find: /!==/, replace: "===", label: "!== → ===" },
  { find: /&&/, replace: "||", label: "&& → ||" },
  { find: /\|\|/, replace: "&&", label: "|| → &&" },
  { find: /<=/, replace: "<", label: "<= → <" },
  { find: />=/, replace: ">", label: ">= → >" },
  { find: /\btrue\b/, replace: "false", label: "true → false" },
  { find: /\bfalse\b/, replace: "true", label: "false → true" },
  { find: /\breturn\b(?!;)/, replace: "return; //", label: "early return" },
];

/** Lines that would only yield noise mutants (comments, imports, blanks). */
function isMutableLine(line: string): boolean {
  const t = line.trim();
  if (t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*"))
    return false;
  if (t.startsWith("import ") || t.startsWith("export type ")) return false;
  return true;
}

/**
 * Generate up to `cap` single-line mutants of the lines the fix ADDED, against
 * the file's current content. Line numbers come from the hunks' new side, so
 * they are valid exactly when {@link reconstructOriginal} succeeded (the
 * current content matches the diff). Deterministic: file order, then line
 * order, then operator order — no randomness, so runs are replayable.
 */
export function generateMutants(
  file: DiffFile,
  currentContent: string,
  cap: number,
): Mutant[] {
  if (cap <= 0 || file.unsupported || file.kind !== "modified") return [];
  const hadTrailingNewline = currentContent.endsWith("\n");
  const lines = currentContent.split("\n");
  if (hadTrailingNewline) lines.pop();

  const mutants: Mutant[] = [];
  for (const hunk of file.hunks) {
    // Walk the hunk's new side tracking absolute line numbers of "+" lines.
    let lineNo = hunk.newStart;
    for (const raw of hunk.lines) {
      const c = raw[0];
      if (c === "-") continue;
      const isAdded = c === "+";
      const text = raw.slice(1);
      if (isAdded && isMutableLine(text) && lines[lineNo - 1] === text) {
        for (const op of MUTATION_OPERATORS) {
          if (mutants.length >= cap) return mutants;
          if (!op.find.test(text)) continue;
          const mutatedLine = text.replace(op.find, op.replace);
          const mutated = [...lines];
          mutated[lineNo - 1] = mutatedLine;
          mutants.push({
            path: file.path,
            line: lineNo,
            description: op.label,
            mutatedContent:
              mutated.join("\n") + (hadTrailingNewline ? "\n" : ""),
          });
          break; // one mutant per line keeps the run bounded and diverse
        }
      }
      lineNo++;
    }
  }
  return mutants;
}

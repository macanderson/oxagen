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
  /**
   * Combined stdout/stderr, needed to tell a suite that FAILED from one that
   * never ran — see {@link classifyWitnessRun}. Optional so an older recorded
   * run still type-checks; absent output is treated as uninformative.
   */
  output?: string;
  /**
   * True for the run of the fail→pass flip — the agent's own claimed witness,
   * and the only run that can settle the verdict on its own.
   */
  isClaim?: boolean;
}

/**
 * Markers that a test command exited non-zero because it could not *run*, not
 * because a test failed.
 *
 * This is the difference the gate exists to see. The shadow revert deletes the
 * files the fix created, so the single most common shape of a real fix — add a
 * module, add a test that imports it — makes the reverted suite fail at import
 * with the module missing. Every runner reports that as an ordinary non-zero
 * exit, so a verdict layer reading only the exit code stamps it
 * "witness tests fail without the fix — the green is real". The tests never
 * ran (#1362).
 *
 * This is not hypothetical: the sibling Rust harness recorded exactly this
 * false proof from a benchmark trace — a confirmed witness off a
 * `ModuleNotFoundError`, found only by reading the full trace.
 *
 * Matching is on output rather than exit code because exit codes do not agree
 * across runners: pytest uses 2 for a collection error and 5 for "no tests
 * collected", while a JS runner reports both as 1.
 */
const DID_NOT_RUN_MARKERS: readonly RegExp[] = [
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /Cannot find module/i,
  /\bMODULE_NOT_FOUND\b/,
  /\bERR_MODULE_NOT_FOUND\b/,
  /Failed to (?:load|resolve) import/i,
  /unresolved import/i,
  /error TS2307/,
  /\bcollection error\b/i,
  /\berrors? during collection\b/i,
  /\bERROR collecting\b/i,
  /\bINTERNALERROR\b/,
  /\bno tests ran\b/i,
  /\bno tests collected\b/i,
  /\bNo test files found\b/i,
  /\bSyntaxError\b/,
  /\bcompilation (?:failed|error)\b/i,
  /\bbuild failed\b/i,
  /\bcommand not found\b/i,
  /\bNo such file or directory\b/i,
];

/** What one witness re-run actually established. */
export type WitnessRunClass =
  | "tests-failed"
  | "tests-passed"
  | "did-not-run"
  | "timed-out";

/**
 * Classify a single re-run. Only `tests-failed` is evidence that the tests
 * witness the fix; the other three are each a reason the run cannot settle
 * anything.
 *
 * The `did-not-run` markers are matched against combined stdout+stderr, which
 * misclassifies a genuine test failure whose own output contains one — a test
 * asserting that a `SyntaxError` is raised, say, reads as a suite that never
 * started. That direction withholds a proof rather than granting one, which is
 * the safe way for this to be wrong, and it is pinned by a test rather than
 * left to be rediscovered. Narrowing it needs a per-runner "tests ran" signal,
 * which none of them agree on.
 */
export function classifyWitnessRun(run: WitnessRun): WitnessRunClass {
  if (run.timedOut || run.exitCode === null) return "timed-out";
  if (run.exitCode === 0) return "tests-passed";
  const output = run.output ?? "";
  if (DID_NOT_RUN_MARKERS.some((marker) => marker.test(output))) {
    return "did-not-run";
  }
  return "tests-failed";
}

/** Layer 2's measurement state — whether a kill rate exists at all. */
export type MutationScoreState =
  | "measured"
  | "not-applicable"
  | "aborted"
  | "workspace-error";

/**
 * Layer 2: patch-scoped mutation-testing score.
 *
 * `killRate` is `null` unless `state` is `"measured"`. It used to default to
 * `1` when no mutant was tried, which rendered a measurement that did not
 * happen as the best possible result — indistinguishable from "the tests
 * caught every mutant", and passing any downstream threshold (#1351). A low
 * score gets investigated; a flattering one does not, which is what made the
 * unmeasured case the dangerous direction to default towards.
 */
export interface MutationScore {
  /** Whether a kill rate was actually measured, and if not, why not. */
  state: MutationScoreState;
  mutantsTried: number;
  mutantsKilled: number;
  /** 0–1 when `state` is `"measured"`; `null` otherwise — never a stand-in. */
  killRate: number | null;
  survivors: Array<{ path: string; line: number; description: string }>;
  /**
   * Files still holding a mutant because restoring them failed. Non-empty
   * means the working tree contains a line nobody wrote.
   *
   * Every entry is a file the gate mutated and could not put back. It is
   * rendered to the user as a list of paths, so nothing else may be pushed
   * into it — an error message here becomes a sentence claiming a MUTANT sits
   * in a file named `Error: …`.
   */
  restoreFailures?: string[];
  /**
   * Why scoring ended in a `workspace-error`, when the cause was an exception
   * rather than a mutant that could not be applied. Kept apart from
   * {@link restoreFailures} because the two make different claims: this says
   * the measurement broke, that says the tree is dirty.
   */
  scoringError?: string;
}

/** One line describing a score, for a status line that must not lie. */
export function describeMutationScore(score: MutationScore): string {
  if (score.state === "measured" && score.killRate !== null) {
    return `mutant kill rate ${Math.round(score.killRate * 100)}% (${score.mutantsKilled}/${score.mutantsTried})`;
  }
  if (score.state === "not-applicable") {
    return "mutant kill rate not measured (no applicable mutants)";
  }
  // A pass that stopped partway still did real work, and dropping it would
  // trade one silence for another — so the progress is named as a count of
  // what ran, never as a rate over what did not.
  const progress =
    score.mutantsTried > 0
      ? `, ${score.mutantsKilled}/${score.mutantsTried} mutants ran`
      : "";
  if (score.state === "aborted") {
    return `mutant kill rate not measured (scoring aborted${progress})`;
  }
  return `mutant kill rate not measured (workspace error during scoring${progress})`;
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

/** The verdict of the shadow re-runs, with the sentence explaining it. */
export interface WitnessVerdict {
  status: MutationGateStatus;
  reason: string;
}

/**
 * Decide what the shadow re-runs established.
 *
 * The rule is that **the claim decides and corroboration cannot substitute for
 * it**. `planWitnessCommands` puts the fail→pass flip first precisely because
 * it is the agent's own claimed witness, and it used to carry no more weight
 * than any other command: a turn whose flip command passed without the fix —
 * genuinely vacuous — still reported `witnessed` if some unrelated third
 * command happened to fail (#1359).
 *
 * Three things now separate a proof from a non-answer, where the old
 * `runs.some(r => r.timedOut || r.exitCode !== 0)` saw one:
 *
 * - A run that **timed out** proves nothing. It says the command did not
 *   finish inside the cap, which happens on a loaded box, on a suite slower
 *   than the cap, on an interactive prompt the reverted code reaches, or on an
 *   infinite loop introduced by the revert itself — the reconstructed pre-fix
 *   file is not a state the code was ever tested in. A timeout is
 *   infrastructure trouble, and the gate already has the honest answer for
 *   that: `skipped` with a reason, the same path as "diff unparseable".
 * - A run that **could not start** proves nothing either — see
 *   {@link classifyWitnessRun} and #1362.
 * - Only `tests-failed` is a proof, and only the claim's own result can turn
 *   the verdict `vacuous`.
 *
 * The direction matters: `applyGateToVerdict` folds only a `vacuous` result
 * back into the revise loop, so a wrong `witnessed` is silent by construction
 * and nothing downstream can notice it.
 */
export function witnessOutcome(runs: WitnessRun[]): WitnessVerdict {
  if (runs.length === 0) {
    return { status: "skipped", reason: "no witness command was re-run" };
  }

  const claim = runs.find((run) => run.isClaim);
  if (claim !== undefined) {
    const claimClass = classifyWitnessRun(claim);
    if (claimClass === "tests-failed") {
      return {
        status: "witnessed",
        reason: "witness tests fail without the fix — the green is real",
      };
    }
    if (claimClass === "tests-passed") {
      return {
        status: "vacuous",
        reason:
          "witness tests still pass with the fix reverted — the tests do not witness the fix",
      };
    }
    return {
      status: "skipped",
      reason:
        claimClass === "timed-out"
          ? `witness command \`${claim.command}\` did not finish inside the per-command cap, so nothing was established`
          : `witness command \`${claim.command}\` failed before running any test (missing module, collection or build error), so its failure is not evidence`,
    };
  }

  // No flip this turn: the claim came from changed test files, so every run is
  // corroboration and any real failure is enough.
  const classes = runs.map(classifyWitnessRun);
  if (classes.includes("tests-failed")) {
    return {
      status: "witnessed",
      reason: "witness tests fail without the fix — the green is real",
    };
  }
  const stalled = runs.filter(
    (_, index) =>
      classes[index] === "timed-out" || classes[index] === "did-not-run",
  );
  if (stalled.length > 0) {
    return {
      status: "skipped",
      reason: `no witness command both ran and failed; ${stalled
        .map((run) => `\`${run.command}\``)
        .join(", ")} did not produce a usable result`,
    };
  }
  return {
    status: "vacuous",
    reason:
      "witness tests still pass with the fix reverted — the tests do not witness the fix",
  };
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

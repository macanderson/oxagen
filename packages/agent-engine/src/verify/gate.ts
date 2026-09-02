/**
 * Mutation verifier — the I/O half.
 *
 * Orchestrates the shadow revert against the {@link Workspace} port (never raw
 * fs / child_process, so every step is injectable and unit-testable):
 *
 *   1. Parse the turn's diff; partition into test vs source segments.
 *   2. Guard: only run when the turn made a witness CLAIM (spec-test oracle
 *      flipped, or test files changed) and there is a passing test-like
 *      command to re-run. Everything else → "skipped", silently cheap.
 *   3. Snapshot the current (post-fix) contents of every source file in the
 *      diff, then revert them to their reconstructed pre-fix contents. Test
 *      files are NOT touched — their current content is the claim under test.
 *   4. Re-run the witness commands. Any failure ⇒ the tests witness the fix
 *      ("witnessed"). All green without the fix ⇒ "vacuous".
 *   5. Layer 2 (opt-in): with the fix RESTORED, apply deterministic one-line
 *      mutants to the lines the fix added and measure how many the witness
 *      command kills. A low kill rate means the tests barely constrain the
 *      patch even though they technically witness it.
 *   6. ALWAYS restore the snapshots (finally). A restore failure throws loudly
 *      — silently continuing on a corrupted working tree would be worse than
 *      failing the turn.
 *
 * The gate is fail-open: infrastructure trouble yields "skipped" with a
 * reason, never a rejection. Only a clean revert followed by green tests can
 * produce "vacuous".
 */
import type { Workspace } from "../types";
import {
  parseUnifiedDiff,
  partitionByTestPath,
  reconstructOriginal,
  planWitnessCommands,
  hasWitnessClaim,
  witnessOutcome,
  generateMutants,
  type DiffFile,
  type MutationGateResult,
  type MutationScore,
  type TestEvidence,
  type WitnessRun,
} from "./mutation";

export interface MutationGateOptions {
  /** Per-command timeout for witness re-runs (default 180_000 ms). */
  timeoutMsPerCommand?: number;
  /** Max witness commands to re-run (default 3). */
  maxCommands?: number;
  /** Layer 2: score the patch with deterministic mutants (default off). */
  score?: boolean;
  /** Max mutants to try when scoring (default 4). */
  maxMutants?: number;
  /** Abort mid-gate (the turn's signal). The shadow is still restored. */
  signal?: AbortSignal;
  /**
   * Fired once, after every guard has passed and JUST BEFORE the shadow revert
   * begins — the moment the turn visibly pauses for a test re-run. Lets the
   * caller surface "reverting fix to verify tests witness it" to the user.
   */
  onStart?: (info: { commands: string[]; revertedFiles: string[] }) => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_COMMANDS = 3;
const DEFAULT_MAX_MUTANTS = 4;

/** Single-quote a path for POSIX shells (the only shell-out we do is `rm`). */
function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

/** A file's pre-gate state, for restore. */
interface Snapshot {
  path: string;
  existed: boolean;
  content: string;
}

function skipped(
  reason: string,
  startedAt: number,
  testFiles: string[],
): MutationGateResult {
  return {
    status: "skipped",
    reason,
    runs: [],
    revertedFiles: [],
    testFiles,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run the mutation gate for one judged-complete round.
 *
 * @param workspace The turn's workspace (must be the same one the agent ran in).
 * @param diff      The turn's cumulative unified diff (`result.diff`).
 * @param evidence  The spec-test oracle's observed test commands + flip.
 */
export async function runMutationGate(
  workspace: Workspace,
  diff: string,
  evidence: TestEvidence,
  opts: MutationGateOptions = {},
): Promise<MutationGateResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMsPerCommand ?? DEFAULT_TIMEOUT_MS;

  let parsed: DiffFile[];
  try {
    parsed = parseUnifiedDiff(diff);
  } catch (err) {
    return skipped(`diff unparseable: ${String(err)}`, startedAt, []);
  }
  const { testFiles, sourceFiles } = partitionByTestPath(parsed);
  const testFilePaths = testFiles.map((f) => f.path);

  if (sourceFiles.length === 0) {
    return skipped(
      "no source files changed (nothing to revert)",
      startedAt,
      testFilePaths,
    );
  }
  if (!hasWitnessClaim(evidence, testFiles.length)) {
    return skipped(
      "no witness claim this turn (no test flip observed and no test files changed)",
      startedAt,
      testFilePaths,
    );
  }
  const commands = planWitnessCommands(
    evidence,
    opts.maxCommands ?? DEFAULT_MAX_COMMANDS,
  );
  if (commands.length === 0) {
    return skipped(
      "no passing test-like command observed to re-run as a witness",
      startedAt,
      testFilePaths,
    );
  }
  const unsupported = sourceFiles.find((f) => f.unsupported);
  if (unsupported) {
    return skipped(
      `cannot faithfully revert ${unsupported.path} (${unsupported.unsupported})`,
      startedAt,
      testFilePaths,
    );
  }

  // ── Snapshot current state + reconstruct pre-fix contents ──
  const snapshots: Snapshot[] = [];
  const reverts: Array<{ file: DiffFile; original: string | null }> = [];
  for (const file of sourceFiles) {
    let current: string | null;
    try {
      current = await workspace.readFile(file.path);
    } catch {
      current = null; // deleted-by-fix files are absent right now
    }
    const original = reconstructOriginal(file, current);
    if (original === undefined) {
      return skipped(
        `cannot reconstruct pre-fix content of ${file.path} (working tree diverged from diff?)`,
        startedAt,
        testFilePaths,
      );
    }
    snapshots.push({
      path: file.path,
      existed: current !== null,
      content: current ?? "",
    });
    reverts.push({ file, original });
  }

  opts.onStart?.({
    commands,
    revertedFiles: reverts.map((r) => r.file.path),
  });

  const runs: WitnessRun[] = [];
  let score: MutationScore | undefined;
  try {
    // ── Revert the fix (test files stay in place) ──
    for (const { file, original } of reverts) {
      if (original === null) {
        // The fix CREATED this file; before the fix it did not exist.
        const rm = await workspace.exec(`rm -- ${shellQuote(file.path)}`, {
          timeoutMs: 30_000,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (rm.exitCode !== 0) {
          return skipped(
            `could not remove created file ${file.path} in shadow (rm exit ${rm.exitCode})`,
            startedAt,
            testFilePaths,
          );
        }
      } else {
        await workspace.writeFile(file.path, original);
      }
    }

    // ── Re-run the witness commands without the fix ──
    for (const command of commands) {
      if (opts.signal?.aborted) {
        return skipped("aborted mid-gate", startedAt, testFilePaths);
      }
      const res = await workspace.exec(command, {
        timeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      runs.push({
        command,
        exitCode: res.timedOut ? null : res.exitCode,
        timedOut: res.timedOut,
      });
    }
  } catch (err) {
    return skipped(
      `shadow run failed: ${String(err)}`,
      startedAt,
      testFilePaths,
    );
  } finally {
    // ── ALWAYS restore the fix — a broken restore must be LOUD ──
    const failures: string[] = [];
    for (const snap of snapshots) {
      try {
        if (snap.existed) {
          await workspace.writeFile(snap.path, snap.content);
        } else {
          const rm = await workspace.exec(`rm -- ${shellQuote(snap.path)}`, {
            timeoutMs: 30_000,
          });
          if (rm.exitCode !== 0) failures.push(snap.path);
        }
      } catch {
        failures.push(snap.path);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `mutation gate could not restore the working tree: ${failures.join(", ")} — ` +
          `the fix may be missing from these files; restore them from the turn diff before continuing.`,
      );
    }
  }

  const status = witnessOutcome(runs);

  // ── Layer 2 (opt-in): mutation-score the patch, fix restored ──
  // `commands[0]` is the first PLANNED witness — the fail→pass flip when the
  // oracle saw one (planWitnessCommands puts it first), otherwise the first
  // passing test-like command. Only one is used: scoring re-runs it once per
  // mutant, so a second command would multiply the cost.
  if (status === "witnessed" && opts.score) {
    score = await scorePatch(workspace, reverts, commands[0]!, {
      timeoutMs,
      maxMutants: opts.maxMutants ?? DEFAULT_MAX_MUTANTS,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  const result: MutationGateResult = {
    status,
    reason:
      status === "witnessed"
        ? "witness tests fail without the fix — the green is real"
        : "witness tests still pass with the fix reverted — the tests do not witness the fix",
    runs,
    revertedFiles: reverts.map((r) => r.file.path),
    testFiles: testFilePaths,
    durationMs: Date.now() - startedAt,
  };
  if (score) result.score = score;
  return result;
}

/**
 * Layer 2: apply deterministic one-line mutants to the fix's added lines (one
 * file at a time, fix otherwise intact) and measure how many the witness
 * command kills. Every mutant write is individually restored.
 *
 * Fail-open on the way in, LOUD on the way out: a workspace read/write/exec
 * failure while trying a mutant just ends the scoring pass (the score is
 * advisory — it must not sink an otherwise-witnessed turn), but a failure to
 * RESTORE a mutated file throws, because leaving a deliberately-broken line in
 * the user's tree silently is the one outcome worse than no score at all.
 */
async function scorePatch(
  workspace: Workspace,
  reverts: Array<{ file: DiffFile; original: string | null }>,
  witnessCommand: string,
  opts: { timeoutMs: number; maxMutants: number; signal?: AbortSignal },
): Promise<MutationScore> {
  const survivors: MutationScore["survivors"] = [];
  let tried = 0;
  let killed = 0;

  for (const { file } of reverts) {
    if (tried >= opts.maxMutants || opts.signal?.aborted) break;
    let current: string;
    try {
      current = await workspace.readFile(file.path);
    } catch {
      continue; // created-then-restored files always exist; belt & braces
    }
    const mutants = generateMutants(file, current, opts.maxMutants - tried);
    let workspaceFailed = false;
    for (const mutant of mutants) {
      if (opts.signal?.aborted) break;
      tried++;
      try {
        await workspace.writeFile(mutant.path, mutant.mutatedContent);
        const res = await workspace.exec(witnessCommand, {
          timeoutMs: opts.timeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (res.timedOut || res.exitCode !== 0) {
          killed++;
        } else {
          survivors.push({
            path: mutant.path,
            line: mutant.line,
            description: mutant.description,
          });
        }
      } catch {
        // Could not apply or run this mutant — the score is advisory, so stop
        // scoring instead of failing a turn the witness runs already cleared.
        tried--;
        workspaceFailed = true;
      } finally {
        try {
          await workspace.writeFile(mutant.path, current);
        } catch (err) {
          throw new Error(
            `mutation gate could not restore ${mutant.path} after mutant "${mutant.description}" ` +
              `(line ${mutant.line}) — the file may still contain the mutation; restore it from ` +
              `the turn diff before continuing. Cause: ${String(err)}`,
          );
        }
      }
      if (workspaceFailed) break;
    }
    if (workspaceFailed) break;
  }

  return {
    mutantsTried: tried,
    mutantsKilled: killed,
    killRate: tried === 0 ? 1 : killed / tried,
    survivors,
  };
}

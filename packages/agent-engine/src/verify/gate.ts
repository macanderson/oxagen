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
        // The output is what separates a suite that failed from one that never
        // ran — a revert deletes the module a new test imports, and that
        // import error is an ordinary non-zero exit (#1362).
        output: `${res.stdout}\n${res.stderr}`,
        // The flip is the agent's own claimed witness, and only it can settle
        // the verdict; the rest corroborate (#1359).
        isClaim: evidence.flippedBy !== null && command === evidence.flippedBy,
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

  const verdict = witnessOutcome(runs);

  // ── Layer 2 (opt-in): mutation-score the patch, fix restored ──
  // `commands[0]` is the first PLANNED witness — the fail→pass flip when the
  // oracle saw one (planWitnessCommands puts it first), otherwise the first
  // passing test-like command. Only one is used: scoring re-runs it once per
  // mutant, so a second command would multiply the cost.
  //
  // Scoring is opt-in and advisory, so it may never reject a turn the witness
  // runs already cleared — including when restoring a mutant fails. That path
  // used to throw straight out of `runMutationGate`, past the try/finally that
  // protects everything else, breaking the gate's own fail-open contract and
  // leaving a deliberately-broken line in a file the agent believes it fixed
  // (#1352).
  if (verdict.status === "witnessed" && opts.score) {
    try {
      score = await scorePatch(workspace, reverts, commands[0]!, {
        timeoutMs,
        maxMutants: opts.maxMutants ?? DEFAULT_MAX_MUTANTS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      // Last resort: `scorePatch` catches its own throws so the restore
      // failures it collected survive, and this only fires if that contract
      // is broken. The error goes in `scoringError`, never in
      // `restoreFailures` — that list is rendered as file paths, so a message
      // pushed into it produced "could not restore Error: … — these files
      // still contain a MUTANT", asserting a broken line is on disk in the
      // one case where the gate has no idea whether it is.
      score = {
        state: "workspace-error",
        mutantsTried: 0,
        mutantsKilled: 0,
        killRate: null,
        survivors: [],
        scoringError: String(err),
      };
    }
  }

  // A mutant left on disk is the one thing here a human must not miss: the
  // tree holds a plausible-looking line nobody wrote, in a file that reads as
  // fixed, and a mutant is designed to survive a glance.
  const mutantsLeftBehind = score?.restoreFailures ?? [];
  let reason = verdict.reason;
  if (mutantsLeftBehind.length > 0) {
    reason +=
      `. WARNING: mutation scoring could not restore ${mutantsLeftBehind.join(", ")} — ` +
      "these files still contain a MUTANT (a deliberately broken line this gate wrote, not a missing fix); " +
      "restore them before committing.";
  }
  // Said separately from the warning above, and only ever as "the measurement
  // broke": an exception out of scoring says nothing about whether a mutant is
  // still on disk, and the two must not be reported as one fact.
  if (score?.scoringError) {
    reason += `. Mutation scoring did not complete: ${score.scoringError}`;
  }

  const result: MutationGateResult = {
    status: verdict.status,
    reason,
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
 * advisory — it must not sink an otherwise-witnessed turn), and a failure to
 * RESTORE a mutated file is collected in `restoreFailures` by path so the
 * caller can name every one of them. It used to throw on the first, out
 * through a call site outside the try/finally protecting the rest of the gate
 * (#1352); the rationale for being loud is unchanged, but the mechanism is a
 * returned list rather than an exception, because leaving a deliberately
 * broken line in the user's tree silently is still the one outcome worse than
 * no score at all — and an exception was losing the other files' names.
 *
 * It does not throw. An unexpected exception anywhere in the pass is caught
 * here and returned as `state: "workspace-error"` **carrying whatever
 * `restoreFailures` had already been collected**, because a real mutant left
 * on disk by an earlier iteration must not be discarded by a later failure.
 */
async function scorePatch(
  workspace: Workspace,
  reverts: Array<{ file: DiffFile; original: string | null }>,
  witnessCommand: string,
  opts: { timeoutMs: number; maxMutants: number; signal?: AbortSignal },
): Promise<MutationScore> {
  const survivors: MutationScore["survivors"] = [];
  const restoreFailures: string[] = [];
  let tried = 0;
  let killed = 0;
  let aborted = false;
  let workspaceError = false;
  let scoringError: string | undefined;

  // Fail-open on the way out too: an exception from anywhere in the pass
  // (a `generateMutants` throw on malformed input, say) used to propagate
  // and discard every `restoreFailures` entry collected so far, so a mutant
  // genuinely left on disk by an earlier iteration was replaced upstream by a
  // fabricated one. The pass ends as a `workspace-error` carrying what it
  // already knows instead.
  try {
    for (const { file } of reverts) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      if (tried >= opts.maxMutants) break;
      let current: string;
      try {
        current = await workspace.readFile(file.path);
      } catch {
        continue; // created-then-restored files always exist; belt & braces
      }
      const mutants = generateMutants(file, current, opts.maxMutants - tried);
      let workspaceFailed = false;
      for (const mutant of mutants) {
        if (opts.signal?.aborted) {
          aborted = true;
          break;
        }
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
          workspaceError = true;
        } finally {
          // Layer 1's restore loop collects its failures by path and names them
          // all; this one used to throw on the first, out through a call site
          // that sits outside the try/finally protecting the rest of the gate.
          // It is now as careful as Layer 1, and the file is named so a human
          // knows a MUTANT is what is in it (#1352).
          try {
            await workspace.writeFile(mutant.path, current);
          } catch {
            restoreFailures.push(
              `${mutant.path} (line ${mutant.line}, mutant "${mutant.description}")`,
            );
          }
        }
        if (workspaceFailed) break;
      }
      if (workspaceFailed) break;
    }
  } catch (err) {
    workspaceError = true;
    scoringError = String(err);
  }

  // A kill rate exists only when mutants ran *and the pass finished*.
  // `tried === 0` used to render as `1` — the best possible score for a
  // measurement that did not happen (#1351). An interrupted pass is the same
  // defect one step along: stopping after three of fifty mutants leaves a
  // ratio, but it is a ratio over whichever subset ran first, not over the
  // patch, and #1351 asks for an aborted pass to be distinguishable from a
  // completed one. So `aborted` and `workspace-error` outrank `measured`
  // rather than being reachable only when nothing ran at all.
  const state: MutationScore["state"] = aborted
    ? "aborted"
    : workspaceError
      ? "workspace-error"
      : tried > 0
        ? "measured"
        : "not-applicable";

  const score: MutationScore = {
    state,
    mutantsTried: tried,
    mutantsKilled: killed,
    killRate: state === "measured" ? killed / tried : null,
    survivors,
  };
  if (restoreFailures.length > 0) score.restoreFailures = restoreFailures;
  if (scoringError !== undefined) score.scoringError = scoringError;
  return score;
}

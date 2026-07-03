/**
 * Best-of-N orchestration — run the same task N times independently and keep the
 * best patch.
 *
 * Each candidate runs the ONE engine loop (`runTurn`, headless verification
 * profile) in its OWN git worktree cut from HEAD, so the N attempts physically
 * cannot clobber each other. By default candidates run `bare` — no evaluate/
 * enhance/judge — since the comparative {@link selectBestCandidate} SELECTOR
 * already judges all N side by side; set `fullPipeline` to opt every candidate
 * into the full evaluate→enhance→route→execute→judge→revise pipeline too (the
 * ENHANCE stage's semantic-embedding + code-graph pre-context, and a per-
 * candidate completeness judge/revise round, at roughly N extra judge-class
 * model calls).
 *
 * Every candidate's worktree survives past its own turn — cleanup is deferred
 * until AFTER selection (the `finally` in {@link runBestOfN}), specifically so
 * `verifyAuto` can still exercise it. An optional `verifyCommand` is run in
 * each candidate's OWN worktree right after its turn (a single fixed command,
 * the existing per-candidate signal). `verifyAuto` goes further: it unions the
 * distinct test/lint/build commands EVERY candidate ran on its own during the
 * turn, then re-runs that whole union in EVERY surviving candidate's worktree
 * — so all N are compared on the SAME executed evidence instead of whatever
 * subset each one happened to run — and feeds the result to the SELECTOR as a
 * decisive `testsPassed` signal (SELECT_SYSTEM already treats executed-test
 * output as decisive; see `packages/agent-engine/src/evaluate/select.ts`). The
 * winner's diff is then applied to the real working tree — falling through to
 * the next-ranked candidate's diff if `git apply` rejects the top pick, rather
 * than giving up — and every worktree is cleaned up.
 *
 * Every step emits a {@link BestOfNEvent} so the CLI can render the whole race
 * live — the point is that the user SEES the orchestration working, not a
 * frozen spinner.
 */
import { runTurn, selectBestCandidate, type AgentAi, type Candidate, type SelectionResult, type ProjectContext } from "@oxagen/agent-engine";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCwdWorkspace, createCodeGraphProvider } from "./adapters/index.js";
import { queryCodeGraph } from "./code-graph.js";
import { runShellCommandBuffered } from "../lib/shell-runner.js";
import { looksPassing } from "@oxagen/agent-engine";
import { resolveEffort } from "./model.js";

const execFileAsync = promisify(execFile);

/** Live events for the best-of-N run — drive the multi-lane view / stream-json. */
export type BestOfNEvent =
  | { type: "start"; candidates: number; prompt: string }
  | { type: "candidate-start"; id: string; model: string }
  | { type: "candidate-progress"; id: string; label: string }
  | { type: "candidate-verify"; id: string; command: string }
  | { type: "candidate-done"; id: string; changedFiles: string[]; steps: number; testsPassed: boolean | null }
  | { type: "candidate-failed"; id: string; error: string }
  | { type: "select-start"; viable: number }
  | { type: "select-done"; winnerId: string | null; reasoning: string; ranking: Array<{ id: string; score: number; note: string }> }
  | { type: "applied"; winnerId: string; changedFiles: string[] }
  | { type: "apply-failed"; winnerId: string; error: string };

export interface BestOfNOptions {
  prompt: string;
  /** Repo root. Candidates are cut from its HEAD; the winner is applied here. */
  cwd: string;
  /** How many candidates to run. */
  candidates: number;
  /** AI port for the candidate turns AND the selector. */
  ai: AgentAi;
  /** Model slugs cycled across candidates for diversity; defaults to one model. */
  models?: string[];
  /**
   * Reasoning effort forwarded to every candidate's turn. Order: this option →
   * `OXAGEN_EFFORT` env → config → the model's own default (see
   * `resolveEffort` in `agent/model.ts`). Undefined here still resolves via
   * env/config, so e.g. `OXAGEN_EFFORT=xhigh` takes effect with no explicit
   * plumbing from the caller.
   */
  effort?: string;
  /** Selector model override. */
  selectorModel?: string;
  /** Max candidates running at once (default min(N, 4)). */
  concurrency?: number;
  /** Read-only candidates (no winner is applied). */
  readOnly?: boolean;
  projectContext?: ProjectContext;
  /**
   * Command run in each candidate's worktree after its turn; its output is the
   * decisive selection signal (test results). Omit to select on diff + summary.
   */
  verifyCommand?: string;
  /**
   * Auto-detect verification: union the distinct test/lint/build commands
   * every candidate ran via the `bash` tool during its own turn, then re-run
   * that whole union in EVERY surviving candidate's worktree (not just the
   * ones that happened to run it themselves) before selection, feeding a
   * decisive `testsPassed` signal to the comparative selector. Complements
   * `verifyCommand` (a single fixed command) rather than replacing it — both
   * can be set. Default false; the CLI defaults this on when
   * `OXAGEN_DIFFERENTIATED=1` (see `resolveVerifyAuto` in `commands/solve.ts`).
   */
  verifyAuto?: boolean;
  /** Apply the winner's diff to `cwd` (default true; forced off for readOnly). */
  apply?: boolean;
  /**
   * Run each candidate through the FULL evaluate→enhance→route→execute→judge→
   * revise pipeline instead of the bare engine loop (default false: bare).
   * Bare is deliberately the default — best-of-N already has a comparative
   * SELECTOR judging all N candidates side by side, so a per-candidate judge
   * too is redundant cost most of the time. Set this when the semantic-enhance
   * fallback (embed the prompt, pull related files from the code graph before
   * the agent starts) and a per-candidate completeness judge/revise round are
   * worth the extra cost — roughly N extra judge-class model calls (one per
   * candidate) on top of the one the selector always makes.
   */
  fullPipeline?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: BestOfNEvent) => void;
}

export interface BestOfNResult {
  /**
   * The candidate whose diff actually landed in the real working tree. Almost
   * always `selection`'s pick, EXCEPT when that candidate's diff failed
   * `git apply` and a lower-ranked candidate's diff was used instead (see the
   * apply-fallback loop in `runBestOfN`) — check `selection.winnerId` for the
   * selector's original (possibly superseded) verdict.
   */
  winner: Candidate | null;
  candidates: Candidate[];
  selection: SelectionResult;
}

/** Run `git` in `cwd`, returning trimmed stdout ("" on failure). */
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    // `git apply`/`diff --no-index` exit non-zero with useful stdout; surface it.
    const e = err as { stdout?: string };
    return typeof e.stdout === "string" ? e.stdout.trim() : "";
  }
}

/** One candidate's turn plus the bookkeeping `runBestOfN` needs AFTER the
 * race: its (not-yet-removed) worktree path and the distinct bash commands it
 * ran, for `verifyAuto`'s cross-candidate test union. */
interface CandidateRun {
  candidate: Candidate;
  /**
   * NOT yet removed — the caller (`runBestOfN`) cleans up every candidate's
   * worktree AFTER selection (and, when `verifyAuto` is on, after re-running
   * tests in it), not here. See the top-of-file comment.
   */
  worktree: string;
  /**
   * Distinct `bash` commands this candidate ran, in the FULL untruncated form
   * captured off the `tool-call` event's parsed input — unlike
   * `result.trace.commandsRun`, which is capped to 120 chars for storage and
   * would silently mis-execute (truncated mid-argument) if replayed verbatim.
   */
  testCommands: string[];
}

/** Pull the shell command out of a `bash` tool call's (parsed) input. */
function extractBashCommand(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const obj = input as { command?: unknown; cmd?: unknown };
    const cmd = obj.command ?? obj.cmd;
    if (typeof cmd === "string" && cmd.trim()) return cmd;
  }
  return undefined;
}

// Commands that look like a test/lint/typecheck/build invocation — the only
// ones `verifyAuto` will replay across every OTHER candidate's worktree.
// Candidates run arbitrary shell commands during their turn (installs, greps,
// `git log`, …); blindly re-executing everything any candidate happened to
// run, in every candidate's worktree, would be wasteful at best and
// destructive at worst (a stray `rm -rf`, `git push`, `curl | sh`, …). Only
// commands that match a known test/verification runner qualify.
const TEST_COMMAND_RE =
  /\b(pytest|py\.test|unittest|nose2?|tox|go test|cargo test|mvn(?:\s+-\S+)*\s+test|gradlew?\s+test|rspec|phpunit|dotnet test|jest|vitest|mocha|ava\b|karma|\btap\b|ctest|rake test|npm (?:run )?test|pnpm (?:run |--filter \S+ )?test\S*|yarn test|make (?:test|check)|tsc\b|eslint|ruff|flake8|pylint)\b/i;

/** Heuristic: does `cmd` look like a test/lint/typecheck/build command? */
function isLikelyTestCommand(cmd: string): boolean {
  return TEST_COMMAND_RE.test(cmd.trim());
}

/** Dedup a list of strings, preserving first-seen order. */
function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((s) => !seen.has(s) && seen.add(s));
}

/** Run one candidate in its own worktree; returns its Candidate summary plus
 * the worktree/commands `runBestOfN` needs for `verifyAuto` + deferred
 * cleanup (this function itself does NOT remove the worktree — see
 * {@link CandidateRun}). */
async function runCandidate(
  id: string,
  // Pinned model slug, or undefined to let the engine apply its own default
  // (`runCodingAgent`'s `opts.model ?? "anthropic/claude-fable-5"`). Must NOT
  // be coerced to a placeholder string here — that string would be sent to
  // the gateway verbatim as the model id and fail to resolve.
  model: string | undefined,
  opts: BestOfNOptions,
  worktreeBase: string,
): Promise<CandidateRun> {
  const emit = opts.onEvent ?? (() => undefined);
  // Display/report label only — never fed back into the engine call.
  const label = model || "default";
  emit({ type: "candidate-start", id, model: label });
  const wt = join(worktreeBase, id);
  const testCommands: string[] = [];

  // Fresh worktree at HEAD — a clean, isolated checkout the candidate can edit.
  // If this fails, the candidate's fs ops throw below and it becomes non-viable.
  await git(["worktree", "add", "--detach", wt, "HEAD"], opts.cwd);

  try {
    // The engine emits the cumulative git diff (untracked files included) via
    // onFileChange — capture the last one as the candidate's patch.
    let candidateDiff = "";
    let candidateFiles: string[] = [];
    const result = await runTurn({
      prompt: opts.prompt,
      workspace: createCwdWorkspace(wt),
      ai: opts.ai,
      model,
      effort: resolveEffort(opts.effort),
      // Default bare (SELECTOR is the sole judge). fullPipeline opts each
      // candidate into evaluate→enhance→route→execute→judge→revise too — see
      // BestOfNOptions.fullPipeline for the cost tradeoff.
      bare: !opts.fullPipeline,
      profile: "headless", // candidates run their own verification
      // Mirror one-shot.ts's headless-mode pipeline defaults (repl/one-shot.ts)
      // so "pipeline on" means the same thing here as it does for a one-shot
      // turn: bound the ENHANCE stage's code-graph pass instead of leaving it
      // unbounded, and judge at the midpoint of a long tool loop so a missing
      // acceptance criterion is caught before the step budget is burned on
      // redundant verification. No-ops when bare (bare skips both stages).
      enhanceTimeoutMs: opts.fullPipeline ? 15_000 : undefined,
      midJudgeSteps: opts.fullPipeline ? 20 : undefined,
      readOnly: opts.readOnly,
      projectContext: opts.projectContext,
      // Query the code_graph against opts.cwd (the real repo root a caller may
      // have pre-built via `oxagen init`), NOT `wt`. The persistent DuckDB store
      // keys rows by exact root path (see daemon/code-graph/store.ts's `WHERE
      // root = ?`), so a fresh worktree path has no rows even though its files
      // are byte-identical to opts.cwd at HEAD — querying `wt` would silently
      // force a full from-scratch tree-sitter rebuild in EVERY candidate,
      // defeating any pre-build and multiplying the cold-build cost by N.
      // Pointing at opts.cwd reuses that pre-built graph, same as one-shot.ts's
      // `queryCodeGraph(cwd, ...)`. Trade-off: a candidate's OWN edits this turn
      // are invisible to code_graph (it reads the pristine pre-worktree state,
      // not the candidate's live edits) — acceptable, since code_graph is a
      // navigation aid for orientation (the graph-first mandate fires before
      // edits) and the agent still has read_file/grep for ground truth on files
      // it has already changed.
      codeGraph: createCodeGraphProvider((op, q, l) => queryCodeGraph(opts.cwd, op, q, l)),
      signal: opts.signal,
      onStage: (s) => emit({ type: "candidate-progress", id, label: s.label }),
      onToolCall: (name, input) => {
        emit({ type: "candidate-progress", id, label: name });
        if (name === "bash") {
          const cmd = extractBashCommand(input);
          if (cmd) testCommands.push(cmd);
        }
      },
      onFileChange: (diff, changedFiles) => {
        candidateDiff = diff;
        candidateFiles = changedFiles;
      },
    });
    const steps = result.steps;

    // Optional verification — the decisive selection signal.
    let testOutput: string | undefined;
    let testsPassed: boolean | null = null;
    if (opts.verifyCommand && !opts.signal?.aborted) {
      emit({ type: "candidate-verify", id, command: opts.verifyCommand });
      const v = await runShellCommandBuffered({ command: opts.verifyCommand, cwd: wt, timeoutMs: 300_000 });
      testOutput = [v.stdout, v.stderr].filter(Boolean).join("\n").trim();
      testsPassed = v.exitCode === 0 && looksPassing(testOutput);
    }

    emit({ type: "candidate-done", id, changedFiles: candidateFiles, steps, testsPassed });
    return {
      candidate: {
        id,
        model: label,
        diff: candidateDiff,
        summary: result.text,
        testOutput,
        testsPassed,
        changedFiles: candidateFiles,
        steps,
      },
      worktree: wt,
      testCommands: dedupe(testCommands),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "candidate-failed", id, error: msg });
    return {
      candidate: { id, model: label, diff: "", summary: msg, changedFiles: [], steps: 0, failed: true },
      worktree: wt,
      testCommands: dedupe(testCommands),
    };
  }
  // No `finally` worktree cleanup here — the worktree must survive past this
  // candidate's own turn so `verifyAuto` can still exercise it. The caller
  // (runBestOfN) removes every candidate's worktree AFTER selection.
}

/** Run `thunks` with a bounded concurrency, preserving order. */
async function pool<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= thunks.length) return;
      results[i] = await thunks[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, () => worker()));
  return results;
}

/**
 * Run best-of-N and apply the winning patch. Always resolves — a failed
 * candidate becomes a non-viable entry, not a thrown error.
 */
export async function runBestOfN(opts: BestOfNOptions): Promise<BestOfNResult> {
  const emit = opts.onEvent ?? (() => undefined);
  const n = Math.max(1, opts.candidates);
  // undefined ⇒ every candidate lets the engine apply its own default model.
  const models: Array<string | undefined> = opts.models && opts.models.length > 0 ? opts.models : [undefined];
  emit({ type: "start", candidates: n, prompt: opts.prompt });

  // fullPipeline mode: warm the shared code-graph cache for opts.cwd NOW, in
  // the background, mirroring one-shot.ts's headless warmup. Every candidate
  // queries the SAME opts.cwd (see runCandidate's codeGraph provider), and
  // getCodeGraph()'s module-level cache is keyed by that path, so this one
  // fire-and-forget call — not one per candidate — is enough: whichever
  // candidate's ENHANCE stage asks first either finds it already warm or
  // shares the same in-flight load as every other candidate.
  if (opts.fullPipeline) {
    void queryCodeGraph(opts.cwd, "search", "__graph_warmup__", 1).catch(() => {});
  }

  const worktreeBase = await mkdtemp(join(tmpdir(), "oxagen-bestof-"));
  const thunks = Array.from({ length: n }, (_, i) => {
    const id = `candidate-${i + 1}`;
    const model = models[i % models.length];
    return () => runCandidate(id, model, { ...opts, models: undefined }, worktreeBase);
  });
  // Every candidate's worktree is kept alive past this point. Cleanup is
  // deferred to the `finally` below — after selection, and after verifyAuto
  // (if on) has re-run tests in each one — instead of per-candidate, so this
  // whole race's worktrees are still there for verifyAuto and the
  // apply-fallback loop to use.
  const runs = await pool(thunks, opts.concurrency ?? Math.min(n, 4));
  const candidates: Candidate[] = runs.map((r) => r.candidate);

  try {
    // AUTO-VERIFY: union the distinct test/lint/build commands every
    // candidate ran on its own, then re-run that whole union in EVERY
    // surviving (non-failed) candidate's worktree — so the selector compares
    // all N on the SAME executed evidence instead of whatever subset of
    // tests each one happened to run by itself.
    if (opts.verifyAuto && !opts.signal?.aborted) {
      const union = dedupe(runs.flatMap((r) => r.testCommands.filter(isLikelyTestCommand)));
      if (union.length > 0) {
        await Promise.all(
          runs.map(async (r) => {
            if (r.candidate.failed || opts.signal?.aborted) return;
            const outputs: string[] = [];
            let allPassed = true;
            for (const cmd of union) {
              if (opts.signal?.aborted) break;
              emit({ type: "candidate-verify", id: r.candidate.id, command: cmd });
              const v = await runShellCommandBuffered({
                command: cmd,
                cwd: r.worktree,
                timeoutMs: 300_000,
                signal: opts.signal,
              });
              const out = [v.stdout, v.stderr].filter(Boolean).join("\n").trim();
              const passed = v.exitCode === 0 && looksPassing(out);
              allPassed = allPassed && passed;
              outputs.push(`$ ${cmd}\n→ ${passed ? "PASS" : "FAIL"} (exit ${v.exitCode})\n${out}`);
            }
            if (outputs.length === 0) return;
            // Append to (don't replace) any verifyCommand output already
            // captured, and let the union's combined pass/fail be decisive —
            // it's the broader, cross-candidate signal.
            r.candidate.testOutput = [r.candidate.testOutput, ...outputs].filter(Boolean).join("\n\n");
            r.candidate.testsPassed = allPassed;
          }),
        );
      }
    }

    // Comparative selection.
    const viable = candidates.filter((c) => !c.failed && (c.diff.trim() || c.testOutput));
    emit({ type: "select-start", viable: viable.length });
    const selection = await selectBestCandidate({
      request: opts.prompt,
      candidates,
      ai: opts.ai,
      selectorModel: opts.selectorModel,
      signal: opts.signal,
    });
    emit({
      type: "select-done",
      winnerId: selection.winnerId,
      reasoning: selection.reasoning,
      ranking: selection.ranking,
    });

    const winner = candidates.find((c) => c.id === selection.winnerId) ?? null;
    let appliedCandidate: Candidate | null = null;

    // Apply the winner's diff to the real working tree (via a temp patch file
    // — `git apply` reads a file more reliably than piped stdin across
    // platforms). If it doesn't apply cleanly, fall through the ranking
    // (best-first) to the next candidate's diff instead of giving up — a
    // next-best diff that DOES apply beats emitting apply-failed on an
    // otherwise-successful race.
    const shouldApply = (opts.apply ?? true) && !opts.readOnly;
    if (winner && shouldApply) {
      const rankedIds = dedupe([winner.id, ...selection.ranking.map((r) => r.id)]);
      let lastError = "";
      let attempted = false;
      for (const id of rankedIds) {
        const candidate = candidates.find((c) => c.id === id);
        if (!candidate || !candidate.diff.trim()) continue;
        attempted = true;
        const patchDir = await mkdtemp(join(tmpdir(), "oxagen-bestof-patch-"));
        try {
          const patchFile = join(patchDir, "winner.patch");
          await writeFile(patchFile, candidate.diff.endsWith("\n") ? candidate.diff : candidate.diff + "\n", "utf8");
          const out = await git(["apply", "--3way", patchFile], opts.cwd);
          if (/error|cannot apply|does not apply/i.test(out)) {
            lastError = out || "git apply failed";
            continue;
          }
          appliedCandidate = candidate;
          break;
        } finally {
          await rm(patchDir, { recursive: true, force: true }).catch(() => {});
        }
      }
      if (appliedCandidate) {
        emit({ type: "applied", winnerId: appliedCandidate.id, changedFiles: appliedCandidate.changedFiles });
      } else if (attempted) {
        emit({ type: "apply-failed", winnerId: winner.id, error: lastError || "git apply failed" });
      }
    }

    return { winner: appliedCandidate ?? winner, candidates, selection };
  } finally {
    // Every candidate's worktree is cleaned up here — after selection and any
    // verifyAuto runs against them — regardless of which candidate's diff
    // ultimately got applied.
    await Promise.all(runs.map((r) => git(["worktree", "remove", "--force", r.worktree], opts.cwd)));
    await rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Best-of-N orchestration — run the same task N times independently and keep the
 * best patch.
 *
 * Each candidate runs the ONE engine loop (`runTurn`, bare + headless
 * verification profile) in its OWN git worktree cut from HEAD, so the N attempts
 * physically cannot clobber each other. An optional `verifyCommand` is run in
 * each candidate's worktree afterwards and its output feeds the comparative
 * {@link selectBestCandidate} judge, which picks the winner (tests-pass →
 * smallest correct change). The winner's diff is applied to the real working
 * tree; every worktree is cleaned up.
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
  /** Apply the winner's diff to `cwd` (default true; forced off for readOnly). */
  apply?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: BestOfNEvent) => void;
}

export interface BestOfNResult {
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

/** Run one candidate in its own worktree; returns its Candidate summary. */
async function runCandidate(
  id: string,
  // Pinned model slug, or undefined to let the engine apply its own default
  // (`runCodingAgent`'s `opts.model ?? "anthropic/claude-fable-5"`). Must NOT
  // be coerced to a placeholder string here — that string would be sent to
  // the gateway verbatim as the model id and fail to resolve.
  model: string | undefined,
  opts: BestOfNOptions,
  worktreeBase: string,
): Promise<Candidate> {
  const emit = opts.onEvent ?? (() => undefined);
  // Display/report label only — never fed back into the engine call.
  const label = model || "default";
  emit({ type: "candidate-start", id, model: label });
  const wt = join(worktreeBase, id);

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
      bare: true, // the SELECTOR is the judge; skip the per-candidate judge/revise
      profile: "headless", // candidates run their own verification
      readOnly: opts.readOnly,
      projectContext: opts.projectContext,
      codeGraph: createCodeGraphProvider((op, q, l) => queryCodeGraph(wt, op, q, l)),
      signal: opts.signal,
      onStage: (s) => emit({ type: "candidate-progress", id, label: s.label }),
      onToolCall: (name) => emit({ type: "candidate-progress", id, label: name }),
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
      id,
      model: label,
      diff: candidateDiff,
      summary: result.text,
      testOutput,
      changedFiles: candidateFiles,
      steps,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "candidate-failed", id, error: msg });
    return { id, model: label, diff: "", summary: msg, changedFiles: [], steps: 0, failed: true };
  } finally {
    // Discard the worktree (best-effort).
    await git(["worktree", "remove", "--force", wt], opts.cwd);
  }
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

  const worktreeBase = await mkdtemp(join(tmpdir(), "oxagen-bestof-"));
  let candidates: Candidate[];
  try {
    const thunks = Array.from({ length: n }, (_, i) => {
      const id = `candidate-${i + 1}`;
      const model = models[i % models.length];
      return () => runCandidate(id, model, { ...opts, models: undefined }, worktreeBase);
    });
    candidates = await pool(thunks, opts.concurrency ?? Math.min(n, 4));
  } finally {
    await rm(worktreeBase, { recursive: true, force: true }).catch(() => {});
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
  emit({ type: "select-done", winnerId: selection.winnerId, reasoning: selection.reasoning, ranking: selection.ranking });

  const winner = candidates.find((c) => c.id === selection.winnerId) ?? null;

  // Apply the winner's diff to the real working tree (via a temp patch file —
  // `git apply` reads a file more reliably than piped stdin across platforms).
  const shouldApply = (opts.apply ?? true) && !opts.readOnly;
  if (winner && winner.diff.trim() && shouldApply) {
    const patchFile = join(await mkdtemp(join(tmpdir(), "oxagen-bestof-patch-")), "winner.patch");
    try {
      await writeFile(patchFile, winner.diff.endsWith("\n") ? winner.diff : winner.diff + "\n", "utf8");
      const out = await git(["apply", "--3way", patchFile], opts.cwd);
      if (/error|cannot apply|does not apply/i.test(out)) {
        emit({ type: "apply-failed", winnerId: winner.id, error: out || "git apply failed" });
      } else {
        emit({ type: "applied", winnerId: winner.id, changedFiles: winner.changedFiles });
      }
    } finally {
      await rm(join(patchFile, ".."), { recursive: true, force: true }).catch(() => {});
    }
  }

  return { winner, candidates, selection };
}
